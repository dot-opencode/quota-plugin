import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { ApiError, isAuthRejection, type Api, type AuthFile } from "./api.ts"
import { getStore, type AccountState } from "./store.ts"
import type { AccountQuota, QuotaWindow } from "./types.ts"

const clamp = (n: number) => Math.max(0, Math.min(100, n))
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
const date = (v: unknown): Date | undefined => {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v)
  if (typeof v === "string" && v) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? undefined : d
  }
  return undefined
}
const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]
  return undefined
}

export function accountName(f: AuthFile): string {
  return f.email || f.label || f.name || f.id || f.auth_index
}

// ---------- claude (from the five-hour-quota-router CPA plugin) ----------
/** Formats an amount given in minor units (cents), e.g. 1234 → "$12.34". */
function money(minor: number, currency = "USD", decimals = 2): string {
  const v = (minor / 10 ** decimals).toFixed(decimals)
  return currency.toUpperCase() === "USD" ? `$${v}` : `${v} ${currency.toUpperCase()}`
}

const ROUTER_SCOPES: [string, string][] = [
  ["five_hour", "5h"],
  ["weekly", "7d"],
  ["fable_weekly", "7d fable"],
  ["opus_weekly", "7d opus"],
  ["sonnet_weekly", "7d sonnet"],
]
const ROUTER_STALE_MS = 15 * 60_000

function rolled(label: string, pct: number, resetsAt: Date | undefined, now: number): QuotaWindow {
  if (resetsAt && resetsAt.getTime() <= now) return { label, remainingPct: 100 }
  return { label, remainingPct: clamp(100 - pct), resetsAt }
}

function routerExtra(e: any, now: number): QuotaWindow | undefined {
  if (!e || typeof e !== "object") return undefined
  const used = num(e.used_credits)
  const limit = num(e.monthly_limit)
  const hasAmounts = used !== undefined && limit !== undefined && limit > 0
  const rejected = e.status === "rejected"
  let pct = num(e.percent_used)
  if (pct === undefined && hasAmounts) pct = (used / limit) * 100
  if (pct === undefined && rejected) pct = 100
  if (pct === undefined) return undefined
  const resetsAt = date(e.reset_at)
  const w = rolled("extra", pct, resetsAt, now)
  if (w.remainingPct === 100 && w.resetsAt === undefined && resetsAt && resetsAt.getTime() <= now) return w
  const currency = typeof e.currency === "string" && e.currency ? e.currency : "USD"
  const decimals = num(e.decimal_places) ?? 2
  const parts: string[] = []
  if (hasAmounts) parts.push(`${money(used, currency, decimals)} / ${money(limit, currency, decimals)}`)
  if (rejected) parts.push("rejected")
  if (parts.length) w.detail = parts.join(" · ")
  return w
}

/** Maps one `accounts[]` entry of the router status to an account result. */
export function mapRouterAccount(base: { provider: string; account: string }, a: any, now: number): AccountQuota {
  const windows: (QuotaWindow & { order: number })[] = []
  const samples: number[] = []
  const sample = (v: unknown) => {
    const d = date(v)
    if (d) samples.push(d.getTime())
  }
  for (const w of Array.isArray(a?.windows) ? a.windows : []) {
    const scope = typeof w?.scope === "string" ? w.scope : ""
    const pct = num(w?.percent_used)
    if (!scope || pct === undefined) continue
    const idx = ROUTER_SCOPES.findIndex(([k]) => k === scope)
    const label = idx >= 0 ? ROUTER_SCOPES[idx]![1] : scope.replace(/_/g, " ")
    windows.push({ ...rolled(label, pct, date(w.reset_at), now), order: idx >= 0 ? idx : ROUTER_SCOPES.length })
    sample(w.sampled_at)
  }
  windows.sort((x, y) => x.order - y.order)
  const out: QuotaWindow[] = windows.map(({ order: _o, ...w }) => w)
  const extra = routerExtra(a?.extra_usage, now)
  if (extra) {
    out.push(extra)
    sample(a.extra_usage.sampled_at)
    sample(a.extra_usage.amounts_sampled_at)
  }
  const refreshError = typeof a?.last_refresh_error === "string" && a.last_refresh_error ? a.last_refresh_error : undefined
  if (!out.length) return { ...base, windows: [], error: refreshError ?? "no quota data yet" }
  const newest = samples.length ? Math.max(...samples) : undefined
  if (newest !== undefined && now - newest > ROUTER_STALE_MS) {
    return { ...base, windows: out, staleSince: new Date(newest), staleReason: refreshError }
  }
  return { ...base, windows: out }
}

// ---------- codex ----------
export function decodeJwtPayload(token: unknown): any {
  if (typeof token !== "string") return undefined
  const part = token.split(".")[1]
  if (!part) return undefined
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/")
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"))
  } catch {
    return undefined
  }
}

export function codexAccountId(f: Pick<AuthFile, "metadata" | "attributes" | "id_token"> & { raw?: any }): string | undefined {
  for (const src of [f.raw, f.metadata, f.attributes]) {
    const v = pick(src, "chatgpt_account_id", "account_id")
    if (typeof v === "string" && v) return v
  }
  const candidates = [f.id_token, f.metadata?.id_token, f.attributes?.id_token]
  for (const c of candidates) {
    // id_token may be a JWT string or an already-decoded object
    const payload = typeof c === "object" && c ? c : decodeJwtPayload(c)
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? payload?.chatgpt_account_id
    if (typeof id === "string" && id) return id
  }
  return undefined
}

function codexLabel(seconds: number | undefined, fallback: string): string {
  if (seconds === 18000) return "5h"
  if (seconds === 604800) return "7d"
  if (seconds !== undefined) {
    const days = seconds / 86400
    if (days >= 28 && days <= 31) return "30d"
  }
  return fallback
}

function codexWindows(rl: any, prefix = ""): QuotaWindow[] {
  if (!rl) return []
  const out: QuotaWindow[] = []
  const limited = rl.limit_reached === true || rl.limitReached === true
  const defs: [any, string][] = [
    [pick(rl, "primary_window", "primaryWindow"), "5h"],
    [pick(rl, "secondary_window", "secondaryWindow"), "7d"],
  ]
  for (const [w, fallback] of defs) {
    if (!w) continue
    const used = num(pick(w, "used_percent", "usedPercent"))
    if (used === undefined) continue
    let resetsAt = date(pick(w, "reset_at", "resetAt"))
    if (!resetsAt) {
      const after = num(pick(w, "reset_after_seconds", "resetAfterSeconds"))
      if (after !== undefined) resetsAt = new Date(Date.now() + after * 1000)
    }
    const label = codexLabel(num(pick(w, "limit_window_seconds", "limitWindowSeconds")), fallback)
    out.push({ label: prefix + label, remainingPct: limited ? 0 : clamp(100 - used), resetsAt })
  }
  return out
}

export function parseCodex(body: any): { plan?: string; windows: QuotaWindow[] } {
  const windows = codexWindows(pick(body, "rate_limit", "rateLimit"))
  const extra = pick(body, "additional_rate_limits", "additionalRateLimits")
  if (Array.isArray(extra)) {
    for (const e of extra) {
      const name = pick(e, "limit_name", "limitName", "metered_feature", "meteredFeature", "name")
      windows.push(...codexWindows(pick(e, "rate_limit", "rateLimit"), name ? `${name} ` : ""))
    }
  }
  // Per-model availability has no percentage: only models that are currently blocked are listed (0%).
  const models = pick(body, "model_usage", "modelUsage")
  if (models && typeof models === "object") {
    for (const [model, m] of Object.entries<any>(models)) {
      if (!m || m.available !== false) continue
      windows.push({ label: model, remainingPct: 0, resetsAt: date(pick(m, "available_at", "availableAt")) })
    }
  }
  const plan = pick(body, "plan_type", "planType")
  return { plan: typeof plan === "string" ? plan : undefined, windows }
}

// ---------- antigravity ----------
export function parseAntigravity(body: any): QuotaWindow[] {
  const out: QuotaWindow[] = []
  const groups = pick(body, "groups")
  if (!Array.isArray(groups)) return out
  for (const g of groups) {
    const name = pick(g, "displayName", "display_name") ?? ""
    const buckets = pick(g, "buckets")
    if (!Array.isArray(buckets)) continue
    for (const b of buckets) {
      const frac = num(pick(b, "remainingFraction", "remaining_fraction"))
      if (frac === undefined) continue
      const window = pick(b, "window") ?? ""
      out.push({
        label: `${name} ${window}`.trim(),
        remainingPct: clamp(frac * 100),
        resetsAt: date(pick(b, "resetTime", "reset_time")),
      })
    }
  }
  return out
}

const AG_HOSTS = [
  "daily-cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
  "cloudcode-pa.googleapis.com",
]
const AG_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "Content-Type": "application/json",
  "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
}

// ---------- kimi ----------
function kimiWindow(label: string, d: any): QuotaWindow | undefined {
  const limit = num(d?.limit)
  const remaining = num(d?.remaining)
  if (limit === undefined || remaining === undefined || limit <= 0) return undefined
  return { label, remainingPct: clamp((remaining / limit) * 100), resetsAt: date(pick(d, "resetTime", "reset_time")) }
}

function kimiLabel(win: any): string {
  const dur = num(win?.duration)
  const unit = String(win?.timeUnit ?? win?.time_unit ?? "").toUpperCase()
  if (dur === undefined) return "limit"
  let minutes: number | undefined
  if (unit.includes("MINUTE")) minutes = dur
  else if (unit.includes("HOUR")) minutes = dur * 60
  else if (unit.includes("DAY")) minutes = dur * 1440
  if (minutes === undefined) return `${dur} ${unit.toLowerCase()}`.trim()
  if (minutes === 300) return "5h"
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

export function parseKimi(body: any): QuotaWindow[] {
  const out: QuotaWindow[] = []
  const weekly = kimiWindow("7d", body?.usage)
  const limits = Array.isArray(body?.limits) ? body.limits : []
  for (const l of limits) {
    const w = kimiWindow(kimiLabel(l?.window), l?.detail)
    if (w) out.push(w)
  }
  if (weekly) out.push(weekly)
  // 5h first, then others, weekly stays after
  return out.sort((a, b) => (a.label === "5h" ? -1 : b.label === "5h" ? 1 : 0))
}

// ---------- fetchers ----------
type Fetcher = (api: Api, f: AuthFile) => Promise<Omit<AccountQuota, "provider" | "account">>

const fetchers: Record<string, Fetcher> = {
  async codex(api, f) {
    const header: Record<string, string> = {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
    }
    const accountId = codexAccountId(f)
    if (accountId) header["Chatgpt-Account-Id"] = accountId
    const body = await api.apiCall({
      authIndex: f.auth_index,
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
      header,
    })
    return parseCodex(body)
  },

  async antigravity(api, f) {
    let lastErr: unknown
    let sawEmpty = false
    let project: string | undefined = f.project_id || f.metadata?.project_id || f.attributes?.project_id
    for (const host of AG_HOSTS) {
      try {
        if (!project) {
          const la = await api.apiCall({
            authIndex: f.auth_index,
            method: "POST",
            url: `https://${host}/v1internal:loadCodeAssist`,
            header: AG_HEADERS,
            data: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
          })
          const p = la?.cloudaicompanionProject
          project = typeof p === "string" ? p : p?.id
        }
        const body = await api.apiCall({
          authIndex: f.auth_index,
          method: "POST",
          url: `https://${host}/v1internal:retrieveUserQuotaSummary`,
          header: AG_HEADERS,
          data: JSON.stringify({ project }),
        })
        const windows = parseAntigravity(body)
        if (windows.length) return { windows }
        sawEmpty = true
      } catch (e) {
        if (isAuthRejection(e)) throw e
        lastErr = e
      }
    }
    if (sawEmpty || !lastErr) return { windows: [] }
    throw lastErr
  },

  async kimi(api, f) {
    const body = await api.apiCall({
      authIndex: f.auth_index,
      method: "GET",
      url: "https://api.kimi.com/coding/v1/usages",
      header: { Authorization: "Bearer $TOKEN$" },
    })
    return { windows: parseKimi(body) }
  },
}

export function supportedProvider(p: string): boolean {
  return p === "claude" || p in fetchers
}

async function attempt(api: Api, f: AuthFile): Promise<{ result: AccountQuota; retryAfterMs?: number }> {
  const base = { provider: f.provider, account: accountName(f) }
  try {
    const r = await fetchers[f.provider]!(api, f)
    return { result: { ...base, ...r } }
  } catch (e) {
    if (isAuthRejection(e)) throw e
    return {
      result: { ...base, windows: [], error: e instanceof Error ? e.message : String(e) },
      retryAfterMs: e instanceof ApiError ? e.retryAfterMs : undefined,
    }
  }
}

export async function fetchAccount(api: Api, f: AuthFile): Promise<AccountQuota> {
  return (await attempt(api, f)).result
}

// ---------- per-account backoff ----------
// Usage endpoints (Anthropic especially) answer 429 when polled too often. After a
// failure we keep showing the last good values and skip that account for a while,
// doubling the pause on each consecutive failure.
const BACKOFF_BASE_MS = 5 * 60_000
const BACKOFF_MAX_MS = 30 * 60_000

const store = getStore()
const accountState = store.accountState

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

function readDisk(): Map<string, AccountState> {
  const out = new Map<string, AccountState>()
  const path = resolveStatePath()
  if (!path) return out
  try {
    const json = JSON.parse(readFileSync(path, "utf8"))
    for (const [key, s] of Object.entries<any>(json?.accounts ?? {})) {
      const r = reviveState(s)
      if (r) out.set(key, r)
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

async function fetchWithBackoff(api: Api, f: AuthFile, now: number): Promise<AccountQuota> {
  loadState()
  const key = `${f.provider}:${f.auth_index}`
  const state = accountState.get(key) ?? { failures: 0, nextAttemptAt: 0 }
  accountState.set(key, state)
  refreshFromDisk(key, state)
  const base = { provider: f.provider, account: accountName(f) }

  const waiting = () => staleView(state, now) ?? { ...base, windows: [], error: state.lastError ?? "waiting to retry" }
  if (now < state.nextAttemptAt) return waiting()

  const minInterval = store.minIntervals[f.provider]
  if (minInterval && state.lastRequestAt !== undefined && now - state.lastRequestAt < minInterval) {
    if (state.failures > 0 || !state.lastGood) return waiting()
    const { staleSince: _s, staleReason: _r, ...view } = staleView(state, now)!
    return view
  }

  state.lastRequestAt = now
  let outcome
  try {
    outcome = await attempt(api, f) // rethrows management auth rejections
  } catch (e) {
    saveState()
    throw e
  }
  const { result, retryAfterMs } = outcome
  if (!result.error) {
    state.lastGood = result
    state.goodAt = now
    state.failures = 0
    state.nextAttemptAt = 0
    state.lastError = undefined
    state.failedAt = undefined
    saveState()
    return result
  }
  state.failures += 1
  state.nextAttemptAt = now + Math.max(backoffMs(state.failures), retryAfterMs ?? 0)
  state.lastError = result.error
  state.failedAt ??= now
  saveState()
  return staleView(state, now) ?? result
}

// ---------- fetchAll with cache ----------
const TTL = 30_000

export function clearCache() {
  store.cache = undefined
  store.inflight = undefined
  accountState.clear()
  store.loaded = false
}

async function fetchClaude(api: Api, files: AuthFile[], now: number): Promise<AccountQuota[]> {
  const base = (f: AuthFile) => ({ provider: f.provider, account: accountName(f) })
  let status: any
  try {
    status = await api.routerStatus()
  } catch (e) {
    if (isAuthRejection(e)) throw e
    const msg = e instanceof Error ? e.message : String(e)
    return files.map((f) => ({ ...base(f), windows: [], error: msg }))
  }
  const byIndex = new Map<string, any>()
  for (const a of Array.isArray(status?.accounts) ? status.accounts : []) {
    if (a?.auth_index !== undefined && a?.auth_index !== null) byIndex.set(String(a.auth_index), a)
  }
  return files.map((f) => {
    const a = byIndex.get(f.auth_index)
    return a ? mapRouterAccount(base(f), a, now) : { ...base(f), windows: [], error: "not in router status" }
  })
}

/**
 * `force` skips the 30s result cache (used by /quota) but still respects
 * per-account backoff, so a manual refresh can't make a 429 worse.
 * Claude accounts never hit an upstream: they come from the router plugin status.
 */
export async function fetchAllQuotas(api: Api, cacheKey = "", force = false, now = Date.now()): Promise<AccountQuota[]> {
  const cache = store.cache
  if (!force && cache && cache.key === cacheKey && now - cache.at < TTL) return cache.data
  if (store.inflight && store.inflight.key === cacheKey) return store.inflight.p
  const p = (async () => {
    const files = (await api.listAuthFiles()).filter((f) => supportedProvider(f.provider))
    const claudeFiles = files.filter((f) => f.provider === "claude")
    const claudeP = claudeFiles.length ? fetchClaude(api, claudeFiles, now) : Promise.resolve([])
    const settled = await Promise.allSettled(
      files.map((f) => (f.provider === "claude" ? undefined : fetchWithBackoff(api, f, now))).filter((x) => x !== undefined),
    )
    const claudeSettled = await Promise.allSettled([claudeP])
    const claudeRes = claudeSettled[0]!
    const rejected =
      settled.find((s) => s.status === "rejected" && isAuthRejection(s.reason)) ??
      (claudeRes.status === "rejected" && isAuthRejection(claudeRes.reason) ? claudeRes : undefined)
    if (rejected) throw (rejected as PromiseRejectedResult).reason
    const others = files.filter((f) => f.provider !== "claude")
    let oi = 0
    let ci = 0
    const data = files.map((f): AccountQuota => {
      if (f.provider === "claude") {
        if (claudeRes.status === "fulfilled") return claudeRes.value[ci++]!
        ci++
        return { provider: f.provider, account: accountName(f), windows: [], error: String(claudeRes.reason) }
      }
      const s = settled[oi]!
      const o = others[oi++]!
      return s.status === "fulfilled"
        ? s.value
        : { provider: o.provider, account: accountName(o), windows: [], error: String(s.reason) }
    })
    store.cache = { at: now, key: cacheKey, data }
    return data
  })()
  const entry = { key: cacheKey, p }
  store.inflight = entry
  try {
    return await p
  } finally {
    if (store.inflight === entry) store.inflight = undefined
  }
}
