import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearCache, fetchAllQuotas, setMinInterval, setStatePath } from "./base.ts"
import { registerQuotaSource, type AccountRef, type FetchResult, type QuotaSource } from "./source.ts"
import { getStore } from "./store.ts"

setStatePath(undefined)
const t0 = Date.parse("2026-10-08T10:00:00Z")

const ok = (pct = 50): FetchResult => ({ windows: [{ label: "5h", remainingPct: pct }] })

function mkSource(id: string, provider: string, keys: string[], opts: Partial<QuotaSource> & { calls?: string[][]; backoff?: boolean } = {}): QuotaSource {
  return {
    id,
    providers: [{ id: provider, backoff: opts.backoff }],
    listAccounts: opts.listAccounts ?? (async () => keys.map((k): AccountRef => ({ provider, key: k, account: `acc-${k}` }))),
    fetch:
      opts.fetch ??
      (async (refs) => {
        opts.calls?.push(refs.map((r) => r.key))
        return new Map(refs.map((r) => [r.key, ok()]))
      }),
    fatal: opts.fatal,
  }
}

beforeEach(() => {
  getStore().registry.sources.clear()
  getStore().registry.listeners.clear()
  setMinInterval("p", undefined)
  clearCache()
})

describe("registry", () => {
  test("register, replace by id, unregister", async () => {
    const reg = getStore().registry
    const off1 = registerQuotaSource(mkSource("a", "p", ["1"]))
    expect(reg.sources.size).toBe(1)
    const replacement = mkSource("a", "q", ["2"])
    const off2 = registerQuotaSource(replacement)
    expect(reg.sources.size).toBe(1)
    expect(reg.sources.get("a")).toBe(replacement)
    off1() // stale unregister must not remove the replacement
    expect(reg.sources.get("a")).toBe(replacement)
    off2()
    expect(reg.sources.size).toBe(0)
    expect((await fetchAllQuotas(true, t0)).accounts).toEqual([])
  })

  test("listeners are notified on register and unregister", () => {
    const reg = getStore().registry
    let n = 0
    reg.listeners.add(() => n++)
    const off = registerQuotaSource(mkSource("a", "p", ["1"]))
    off()
    expect(n).toBe(2)
  })

  test("two sources at once keep registration order and merge providers", async () => {
    registerQuotaSource(mkSource("a", "p", ["1", "2"]))
    registerQuotaSource(mkSource("b", "q", ["9"]))
    const r = await fetchAllQuotas(true, t0)
    expect(r.accounts.map((a) => `${a.provider}:${a.account}`)).toEqual(["p:acc-1", "p:acc-2", "q:acc-9"])
    expect(r.providers.map((p) => p.id)).toEqual(["p", "q"])
    expect(r.rejected).toBeUndefined()
    expect([...getStore().accountState.keys()].sort()).toEqual(["a:p:1", "a:p:2", "b:q:9"])
  })

  test("registry change invalidates the result cache", async () => {
    registerQuotaSource(mkSource("a", "p", ["1"]))
    expect((await fetchAllQuotas(false, t0)).accounts).toHaveLength(1)
    registerQuotaSource(mkSource("b", "q", ["2"]))
    expect((await fetchAllQuotas(false, t0 + 1000)).accounts).toHaveLength(2)
  })
})

describe("per-source errors", () => {
  test("fatal error rejects only that source", async () => {
    registerQuotaSource(
      mkSource("bad", "p", ["1"], {
        fetch: async () => {
          throw new Error("401")
        },
        fatal: (e) => (e instanceof Error && e.message === "401" ? "invalid key (401)" : undefined),
      }),
    )
    registerQuotaSource(mkSource("good", "q", ["2"]))
    const r = await fetchAllQuotas(true, t0)
    expect(r.rejected).toBe("bad: invalid key (401)")
    expect(r.accounts.map((a) => a.account)).toEqual(["acc-2"])
    // not polled again until forced
    const calls: string[][] = []
    registerQuotaSource(mkSource("bad", "p", ["1"], { calls, fatal: () => "nope" }))
    const again = await fetchAllQuotas(true, t0 + 1000)
    expect(again.rejected).toBeUndefined() // forced get succeeded with the replacement
    expect(calls).toEqual([["1"]])
  })

  test("rejected source is skipped on unforced polls", async () => {
    let fetches = 0
    registerQuotaSource(
      mkSource("bad", "p", ["1"], {
        fetch: async () => {
          fetches++
          throw new Error("x")
        },
        fatal: () => "denied",
      }),
    )
    await fetchAllQuotas(true, t0)
    expect(fetches).toBe(1)
    const r = await fetchAllQuotas(false, t0 + 60_000)
    expect(r.rejected).toBe("bad: denied")
    expect(fetches).toBe(1)
    await fetchAllQuotas(true, t0 + 120_000) // forced retry
    expect(fetches).toBe(2)
  })

  test("non-fatal throw becomes per-account error; other sources unaffected", async () => {
    registerQuotaSource(
      mkSource("flaky", "p", ["1"], {
        fetch: async () => {
          throw new Error("boom")
        },
      }),
    )
    registerQuotaSource(mkSource("good", "q", ["2"]))
    const r = await fetchAllQuotas(true, t0)
    expect(r.rejected).toBeUndefined()
    expect(r.accounts[0]!.error).toBe("boom")
    expect(r.accounts[1]!.error).toBeUndefined()
  })

  test("missing key in the result map is an error", async () => {
    registerQuotaSource(mkSource("a", "p", ["1"], { fetch: async () => new Map() }))
    expect((await fetchAllQuotas(true, t0)).accounts[0]!.error).toBe("no result")
  })
})

describe("backoff filtering", () => {
  test("paused account is answered from state and not passed to fetch", async () => {
    const calls: string[][] = []
    let fail = false
    registerQuotaSource(
      mkSource("a", "p", ["1", "2"], {
        fetch: async (refs) => {
          calls.push(refs.map((r) => r.key))
          return new Map(refs.map((r) => [r.key, fail && r.key === "1" ? { error: "429" } : ok(70)]))
        },
      }),
    )
    await fetchAllQuotas(true, t0)
    fail = true
    const r = await fetchAllQuotas(true, t0 + 60_000)
    expect(r.accounts[0]!.staleSince).toBeDefined()
    expect(r.accounts[0]!.windows[0]!.remainingPct).toBe(70)
    await fetchAllQuotas(true, t0 + 2 * 60_000)
    expect(calls).toEqual([["1", "2"], ["1", "2"], ["2"]])
  })

  test("backoff:false providers are always passed to fetch", async () => {
    const calls: string[][] = []
    registerQuotaSource(
      mkSource("a", "p", ["1"], {
        backoff: false,
        calls,
        fetch: async (refs) => {
          calls.push(refs.map((r) => r.key))
          return new Map(refs.map((r) => [r.key, { error: "429" }]))
        },
      }),
    )
    await fetchAllQuotas(true, t0)
    await fetchAllQuotas(true, t0 + 1000)
    expect(calls).toEqual([["1"], ["1"]])
  })

  test("minInterval keeps fetch away from a recently polled account", async () => {
    const calls: string[][] = []
    setMinInterval("p", 15 * 60_000)
    registerQuotaSource(mkSource("a", "p", ["1"], { calls }))
    await fetchAllQuotas(true, t0)
    const r = await fetchAllQuotas(true, t0 + 60_000)
    expect(calls).toEqual([["1"]])
    expect(r.accounts[0]!.staleSince).toBeUndefined()
    setMinInterval("p", undefined)
  })
})

describe("legacy state keys", () => {
  let dir: string
  afterAll(() => {
    setStatePath(undefined)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test("provider:auth_index migrates to cpa: prefix", async () => {
    dir = mkdtempSync(join(tmpdir(), "quota-legacy-"))
    const path = join(dir, "state.json")
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        accounts: { "codex:1": { failures: 2, nextAttemptAt: t0 + 3_600_000, lastError: "429", failedAt: t0, lastRequestAt: t0 } },
      }),
    )
    setStatePath(path)
    clearCache()
    const calls: string[][] = []
    registerQuotaSource(mkSource("cpa", "codex", ["1"], { calls }))
    const r = await fetchAllQuotas(true, t0 + 60_000)
    expect(calls).toEqual([]) // paused by the migrated record
    expect(r.accounts[0]!.error).toBe("429")
    expect(getStore().accountState.has("cpa:codex:1")).toBe(true)
    expect(getStore().accountState.has("codex:1")).toBe(false)
    setStatePath(undefined)
  })
})

test("getStore upgrades a store left by an older version", async () => {
  const { getStore, STORE_KEY } = await import("./store.ts")
  const g = globalThis as any
  const saved = g[STORE_KEY]
  g[STORE_KEY] = { accountState: new Map(), minIntervals: {}, loaded: false, statePathSet: false, poller: { config: {}, listeners: new Set() } }
  try {
    const s = getStore()
    expect(s.registry.listeners).toBeInstanceOf(Set)
    expect(s.registry.sources).toBeInstanceOf(Map)
    expect(s.rejected).toBeInstanceOf(Map)
  } finally {
    g[STORE_KEY] = saved
  }
})
