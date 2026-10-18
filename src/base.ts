import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { AccountRef, FetchResult, ProviderMeta, QuotaSource } from "./source.ts"
import { getStore, type AccountState } from "./store.ts"
import type { AccountQuota } from "./types.ts"

// ---------- per-account backoff ----------
// Usage endpoints (Anthropic especially) answer 429 when polled too often. After a
// failure we keep showing the last good values and skip that account for a while,
// doubling the pause on each consecutive failure.
const BACKOFF_BASE_MS = 5 * 60_000
const BACKOFF_MAX_MS = 30 * 60_000

const store = getStore()
const accountState = store.accountState

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

// Minimum time between upstream requests per account, by provider. Within it the
// last good values are returned without a request, even for a forced refresh.
export function setMinInterval(provider: string, ms: number | undefined) {
  if (ms === undefined) delete store.minIntervals[provider]
  else store.minIntervals[provider] = ms
}

// ---------- persistence ----------
// State survives restarts so a fresh process doesn't immediately hit the upstream again,
// and is re-read per account so several processes sharing the file see each other's pauses.
const defaultStatePath = () =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode-cpa-quota", "state.json")

/** Overrides the state file location; `undefined` disables persistence. */
export function setStatePath(path: string | undefined) {
  store.statePath = path
  store.statePathSet = true
  store.loaded = false
  accountState.clear()
}

const resolveStatePath = () => (store.statePathSet ? store.statePath : defaultStatePath())

function reviveQuota(q: any): AccountQuota | undefined {
  if (!q || typeof q !== "object" || !Array.isArray(q.windows)) return undefined
  return {
    ...q,
    windows: q.windows.map((w: any) => ({ ...w, resetsAt: w.resetsAt ? new Date(w.resetsAt) : undefined })),
  }
}

function reviveState(s: any): AccountState | undefined {
  if (!s || typeof s !== "object") return undefined
  return {
    lastGood: reviveQuota(s.lastGood),
    goodAt: num(s.goodAt),
    failures: num(s.failures) ?? 0,
    nextAttemptAt: num(s.nextAttemptAt) ?? 0,
    lastError: typeof s.lastError === "string" ? s.lastError : undefined,
    failedAt: num(s.failedAt),
    lastRequestAt: num(s.lastRequestAt),
  }
}

/** Legacy keys (`provider:auth_index`, one colon) predate sources and belong to the CPA source. */
export function migrateKey(key: string): string {
  return key.split(":").length === 2 ? `cpa:${key}` : key
}

function readDisk(): Map<string, AccountState> {
  const out = new Map<string, AccountState>()
  const path = resolveStatePath()
  if (!path) return out
  try {
    const json = JSON.parse(readFileSync(path, "utf8"))
    for (const [key, s] of Object.entries<any>(json?.accounts ?? {})) {
      const r = reviveState(s)
      if (r) out.set(migrateKey(key), r)
    }
  } catch {
    // missing or corrupt: start fresh
  }
  return out
}

/** Merges a disk record into the in-memory one (in place): newer information wins. */
function mergeInto(mem: AccountState, disk: AccountState) {
  const memNext = mem.failures > 0 ? mem.nextAttemptAt : 0
  mem.lastRequestAt = Math.max(mem.lastRequestAt ?? 0, disk.lastRequestAt ?? 0) || undefined
  if ((disk.goodAt ?? 0) > (mem.goodAt ?? 0)) {
    mem.goodAt = disk.goodAt
    mem.lastGood = disk.lastGood
  }
  // A success newer than the other side's failure clears that failure.
  const clearedBy = (ok: AccountState, failing: AccountState) =>
    ok.failures === 0 && failing.failedAt !== undefined && (ok.goodAt ?? 0) > failing.failedAt
  let winner: AccountState
  if (mem.failures > 0 && disk.failures > 0) {
    const m = mem.failedAt ?? 0
    const d = disk.failedAt ?? 0
    winner = d > m || (d === m && disk.nextAttemptAt > mem.nextAttemptAt) ? disk : mem
  } else if (disk.failures > 0) winner = clearedBy(mem, disk) ? mem : disk
  else if (mem.failures > 0) winner = clearedBy(disk, mem) ? disk : mem
  else winner = mem
  if (winner === disk) {
    mem.failures = disk.failures
    mem.nextAttemptAt = disk.nextAttemptAt
    mem.lastError = disk.lastError
    mem.failedAt = disk.failedAt
  } else if (winner.failures === 0) {
    mem.failures = 0
    mem.nextAttemptAt = 0
    mem.lastError = undefined
    mem.failedAt = undefined
  }
  if (mem.failures > 0) mem.nextAttemptAt = Math.max(mem.nextAttemptAt, memNext, disk.failures > 0 ? disk.nextAttemptAt : 0)
}

function loadState() {
  if (store.loaded) return
  store.loaded = true
  for (const [key, s] of readDisk()) {
    const mem = accountState.get(key)
    if (mem) mergeInto(mem, s)
    else accountState.set(key, s)
  }
}

/** Re-reads one account's entry from disk (other processes may have updated it). */
function refreshFromDisk(key: string, mem: AccountState) {
  if (!resolveStatePath()) return
  const disk = readDisk().get(key)
  if (disk) mergeInto(mem, disk)
}

function saveState() {
  const path = resolveStatePath()
  if (!path) return
  try {
    // Merge with what other processes wrote meanwhile, so we don't clobber their entries.
    for (const [key, s] of readDisk()) {
      const mem = accountState.get(key)
      if (mem) mergeInto(mem, s)
      else accountState.set(key, s)
    }
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, accounts: Object.fromEntries(accountState) }))
    renameSync(tmp, path)
  } catch {
    // best-effort
  }
}

export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS)
}

/** Last good values; windows whose reset time has passed are shown as full again. */
function staleView(state: AccountState, now: number): AccountQuota | undefined {
  const good = state.lastGood
  if (!good) return undefined
  return {
    ...good,
    windows: good.windows.map((w) =>
      w.resetsAt && w.resetsAt.getTime() <= now ? { label: w.label, remainingPct: 100 } : w,
    ),
    staleSince: new Date(state.goodAt ?? state.failedAt ?? now),
    staleReason: state.lastError,
  }
}

// ---------- fetchAll with cache ----------
const TTL = 30_000

export interface FetchAllResult {
  accounts: AccountQuota[]
  /** Providers of all registered sources, in order, deduped by id. */
  providers: ProviderMeta[]
  /** Per-source rejection messages, e.g. "cpa: invalid key (401)". */
  rejected?: string
  failed: boolean
}

export function clearCache() {
  store.cache = undefined
  store.inflight = undefined
  store.rejected.clear()
  store.lastAccounts.clear()
  accountState.clear()
  store.loaded = false
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface SourceOut {
  accounts: AccountQuota[]
  failed: boolean
}

async function runSource(src: QuotaSource, force: boolean, now: number): Promise<SourceOut> {
  const last = () => store.lastAccounts.get(src.id) ?? []
  const fatal = (e: unknown): boolean => {
    let msg: string | undefined
    try {
      msg = src.fatal?.(e)
    } catch {
      msg = undefined
    }
    if (msg === undefined) return false
    store.rejected.set(src.id, msg)
    return true
  }
  if (store.rejected.has(src.id) && !force) return { accounts: last(), failed: true }

  let refs: AccountRef[]
  try {
    refs = await src.listAccounts()
  } catch (e) {
    if (fatal(e)) return { accounts: last(), failed: true }
    const accounts = last().map((a) => ({ ...a, error: errMsg(e) }))
    return { accounts, failed: true }
  }

  loadState()
  const metas = new Map(src.providers.map((p) => [p.id, p]))
  const slots: (AccountQuota | undefined)[] = refs.map(() => undefined)
  const pending: { i: number; ref: AccountRef; state?: AccountState }[] = []

  refs.forEach((ref, i) => {
    const base = { provider: ref.provider, account: ref.account }
    if (metas.get(ref.provider)?.backoff === false) {
      pending.push({ i, ref })
      return
    }
    const skey = `${src.id}:${ref.provider}:${ref.key}`
    const state = accountState.get(skey) ?? { failures: 0, nextAttemptAt: 0 }
    accountState.set(skey, state)
    refreshFromDisk(skey, state)
    const waiting = () => staleView(state, now) ?? { ...base, windows: [], error: state.lastError ?? "waiting to retry" }
    if (now < state.nextAttemptAt) {
      slots[i] = waiting()
      return
    }
    const minInterval = store.minIntervals[ref.provider]
    if (minInterval && state.lastRequestAt !== undefined && now - state.lastRequestAt < minInterval) {
      if (state.failures > 0 || !state.lastGood) slots[i] = waiting()
      else {
        const { staleSince: _s, staleReason: _r, ...view } = staleView(state, now)!
        slots[i] = view
      }
      return
    }
    state.lastRequestAt = now
    pending.push({ i, ref, state })
  })

  let results: Map<string, FetchResult> | undefined
  let failure: unknown
  let hasFailure = false
  if (pending.length) {
    try {
      results = await src.fetch(pending.map((p) => p.ref))
    } catch (e) {
      hasFailure = true
      failure = e
    }
  }
  if (hasFailure && fatal(failure)) {
    saveState()
    return { accounts: last(), failed: true }
  }

  for (const { i, ref, state } of pending) {
    const base = { provider: ref.provider, account: ref.account }
    const r: FetchResult = hasFailure ? { error: errMsg(failure) } : (results?.get(ref.key) ?? { error: "no result" })
    const retryAfterMs = "retryAfterMs" in r ? r.retryAfterMs : undefined
    const result: AccountQuota = "windows" in r ? { ...base, ...r } : { ...base, windows: [], error: r.error }
    if (!state) {
      slots[i] = result
      continue
    }
    if (!result.error) {
      state.lastGood = result
      state.goodAt = now
      state.failures = 0
      state.nextAttemptAt = 0
      state.lastError = undefined
      state.failedAt = undefined
      slots[i] = result
      continue
    }
    state.failures += 1
    state.nextAttemptAt = now + Math.max(backoffMs(state.failures), retryAfterMs ?? 0)
    state.lastError = result.error
    state.failedAt ??= now
    slots[i] = staleView(state, now) ?? result
  }
  if (pending.length) saveState()

  store.rejected.delete(src.id)
  const accounts = slots as AccountQuota[]
  store.lastAccounts.set(src.id, accounts)
  return { accounts, failed: false }
}

/**
 * Polls every registered source. `force` skips the 30s result cache (used by /quota) and
 * retries rejected sources, but still respects per-account backoff, so a manual refresh
 * can't make a 429 worse.
 */
export async function fetchAllQuotas(force = false, now = Date.now()): Promise<FetchAllResult> {
  const version = store.registry.version
  const cache = store.cache
  if (!force && cache && cache.version === version && now - cache.at < TTL) return cache.data
  if (store.inflight && store.inflight.version === version) return store.inflight.p
  const p = (async (): Promise<FetchAllResult> => {
    const sources = [...store.registry.sources.values()]
    for (const id of [...store.rejected.keys()]) if (!store.registry.sources.has(id)) store.rejected.delete(id)
    for (const id of [...store.lastAccounts.keys()]) if (!store.registry.sources.has(id)) store.lastAccounts.delete(id)
    const outs = await Promise.all(sources.map((s) => runSource(s, force, now)))
    const providers: ProviderMeta[] = []
    for (const s of sources) for (const m of s.providers) if (!providers.some((x) => x.id === m.id)) providers.push(m)
    const rejected = sources
      .filter((s) => store.rejected.has(s.id))
      .map((s) => `${s.id}: ${store.rejected.get(s.id)}`)
      .join("; ")
    const data: FetchAllResult = {
      accounts: outs.flatMap((o) => o.accounts),
      providers,
      rejected: rejected || undefined,
      failed: outs.some((o) => o.failed),
    }
    store.cache = { at: now, version, data }
    return data
  })()
  const entry = { version, p }
  store.inflight = entry
  try {
    return await p
  } finally {
    if (store.inflight === entry) store.inflight = undefined
  }
}
