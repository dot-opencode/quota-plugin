import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApiError, createApi, type Api, type CodexEntry } from "./api.ts"
import { loadConfig } from "./config.ts"
import { compactLine } from "../../format.ts"
import { backoffMs, clearCache, fetchAllQuotas as fetchAll, setMinInterval, setStatePath } from "../../base.ts"
import { registerQuotaSource } from "../../source.ts"
import { getStore } from "../../store.ts"
import { mapRouterAccount, parseCodex } from "./parsers.ts"
import { createCpaSource, CPA_PROVIDERS } from "./index.ts"
import type { AccountQuota } from "../../types.ts"

/** Runs one poll over a fresh CPA source backed by `api`. */
async function poll(api: Api, force = true, now = Date.now()) {
  getStore().registry.sources.clear()
  registerQuotaSource(createCpaSource(api, "cpa", () => now))
  return fetchAll(force, now)
}
const fetchAllQuotas = async (api: Api, _key = "", force = false, now = Date.now()): Promise<AccountQuota[]> =>
  (await poll(api, force, now)).accounts

// Never touch the real home dir: persistence is off unless a test sets a temp path.
setStatePath(undefined)

describe("providers", () => {
  test("codex", () => {
    const r = parseCodex({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1790000000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 3600 },
      },
      additional_rate_limits: [
        { limit_name: "spark", rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000 } } },
      ],
    })
    expect(r.plan).toBe("plus")
    expect(r.windows.map((x) => [x.label, x.remainingPct])).toEqual([["5h", 90], ["7d", 60], ["spark 5h", 99]])
    expect(r.windows[0]!.resetsAt?.getTime()).toBe(1790000000 * 1000)
  })

  test("codex: blocked models from model_usage", () => {
    const r = parseCodex({
      rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 604800 } },
      model_usage: {
        "gpt-6-astra": { available: true, available_at: null },
        "gpt-6-pro": { available: false, available_at: 1790000000 },
      },
    })
    expect(r.windows.map((x) => [x.label, x.remainingPct])).toEqual([["7d", 75], ["gpt-6-pro", 0]])
    expect(r.windows[1]!.resetsAt?.getTime()).toBe(1790000000 * 1000)
  })

  test("codex camelCase, limit reached, 30d", () => {
    const r = parseCodex({
      rateLimit: { limitReached: true, primaryWindow: { usedPercent: 50, limitWindowSeconds: 30 * 86400 } },
    })
    expect(r.windows).toHaveLength(1)
    expect(r.windows[0]!.label).toBe("30d")
    expect(r.windows[0]!.remainingPct).toBe(0)
  })
})

describe("api", () => {
  test("config", () => {
    expect(loadConfig({}, { CPA_URL: "https://x.io/", CPA_QUOTA_KEY: "k" })).toEqual({ url: "https://x.io", key: "k", refreshSec: 300 })
    expect(loadConfig({ refreshSec: 30, url: "https://o.io//" }, {}).url).toBe("https://o.io")
    expect(loadConfig({}, { CPA_QUOTA_KEY: "k" }).url).toBeUndefined()
    expect(loadConfig({}, { CPA_URL: "https://x.io", CPA_MANAGEMENT_KEY: "k" } as any).key).toBeUndefined()
  })
})

const acc = (provider: string, account: string, r5: number, r7: number, extra: Partial<AccountQuota> = {}): AccountQuota => ({
  provider,
  account,
  windows: [{ label: "5h", remainingPct: r5 }, { label: "7d", remainingPct: r7 }],
  ...extra,
})

const t0 = Date.parse("2026-10-08T10:00:00Z")
const usageOf = (used: number, at = t0) => ({
  rate_limit: {
    primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: (at + 60 * 60000) / 1000 },
    secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: (at + 3 * 86400000) / 1000 },
  },
})

interface CodexState {
  calls: number
  used: number
  err?: string
  retryAfterMs?: number
  /** Keep usage next to the error (last known values). */
  withUsage?: boolean
}
/** Api whose single quota response carries one codex account driven by `s`. */
const mkApi = (s: CodexState): Api => ({
  quota: async () => {
    s.calls++
    const e: CodexEntry = { auth_index: "1", email: "a" }
    if (!s.err || s.withUsage) e.usage = usageOf(s.used)
    if (s.err) e.error = s.err
    if (s.retryAfterMs) e.retry_after_ms = s.retryAfterMs
    return { codex: [e] }
  },
})
const pct5 = (r: AccountQuota[]) => r[0]!.windows.find((w) => w.label === "5h")!.remainingPct

describe("quota route errors", () => {
  test("401 shows a message and does not stop polling", async () => {
    clearCache()
    let n = 0
    const api: Api = { quota: async () => (n++, Promise.reject(new ApiError("CPA quota key rejected (401)", 401))) }
    const r = await poll(api, false, t0)
    expect(r.rejected).toBeUndefined()
    expect(r.accounts[0]!.error).toBe("CPA quota key rejected (401)")
    await poll(api, false, t0 + 60_000)
    expect(n).toBe(2)
  })

  test("404 asks to update the router plugin and configure quota-api-keys", async () => {
    clearCache()
    const api = createApi({ url: "https://cpa.test", key: "k" }, (async () => new Response("{}", { status: 404 })) as any)
    const r = await poll(api, true, t0)
    expect(r.rejected).toBeUndefined()
    expect(r.accounts[0]!.error).toContain("five-hour-quota-router")
    expect(r.accounts[0]!.error).toContain("quota-api-keys")
  })

  test("other failures are plain errors", async () => {
    clearCache()
    const r = await poll({ quota: async () => { throw new ApiError("quota HTTP 500", 500) } }, true, t0)
    expect(r.rejected).toBeUndefined()
    expect(r.failed).toBe(true)
  })

  test("createApi hits the resource route with the bearer key", async () => {
    const seen: { url: string; auth: string | null }[] = []
    const fakeFetch = (async (u: string, init: any) => {
      seen.push({ url: u, auth: new Headers(init.headers).get("authorization") })
      return new Response(JSON.stringify({ claude: { accounts: [] }, codex: [] }))
    }) as any
    const api = createApi({ url: "https://cpa.test", key: "k" }, fakeFetch)
    expect(await api.quota()).toEqual({ claude: { accounts: [] }, codex: [] })
    expect(seen).toEqual([{ url: "https://cpa.test/v0/resource/plugins/five-hour-quota-router/quota", auth: "Bearer k" }])
    const bad = createApi({ url: "https://cpa.test", key: "k" }, (async () => new Response("", { status: 401 })) as any)
    await expect(bad.quota()).rejects.toMatchObject({ message: "CPA quota key rejected (401)", status: 401 })
  })
})

describe("codex entries", () => {
  test("usage and error: last known values shown, treated as stale", async () => {
    clearCache()
    setMinInterval("codex", undefined)
    const s: CodexState = { calls: 0, used: 30 }
    const api = mkApi(s)
    expect(pct5(await fetchAllQuotas(api, "", true, t0))).toBe(70)
    s.err = "HTTP 429"
    s.withUsage = true
    s.used = 40
    const r = await fetchAllQuotas(api, "", true, t0 + 60_000)
    expect(r[0]!.error).toBeUndefined()
    expect(r[0]!.staleSince).toBeDefined()
    expect(r[0]!.staleReason).toBe("HTTP 429")
    expect(pct5(r)).toBe(70)
    setMinInterval("codex", 15 * 60_000)
  })

  test("error only: error with retryAfterMs", async () => {
    clearCache()
    setMinInterval("codex", undefined)
    const s: CodexState = { calls: 0, used: 30, err: "upstream HTTP 429", retryAfterMs: 60 * 60_000 }
    const api = mkApi(s)
    const first = await fetchAllQuotas(api, "", true, t0)
    expect(first[0]!.error).toBe("upstream HTTP 429")
    // Retry-After extends the pause beyond the 5 min backoff.
    s.err = undefined
    s.retryAfterMs = undefined
    expect((await fetchAllQuotas(api, "", true, t0 + 30 * 60_000))[0]!.error).toBe("upstream HTTP 429")
    expect(pct5(await fetchAllQuotas(api, "", true, t0 + 60 * 60_000 + 1))).toBe(70)
    setMinInterval("codex", 15 * 60_000)
  })

  test("accounts come from the response, keyed by auth_index; claude and codex share one request", async () => {
    clearCache()
    let n = 0
    const api: Api = {
      quota: async () => (
        n++,
        {
          claude: { accounts: [{ auth_index: "c1", windows: [{ scope: "five_hour", percent_used: 10, sampled_at: new Date(t0 - 1000).toISOString() }] }] },
          codex: [{ auth_index: 7, label: "work", usage: usageOf(20) } as any, { auth_index: "8", email: "e@x", error: "boom" }],
        }
      ),
    }
    const r = await fetchAllQuotas(api, "", true, t0)
    expect(n).toBe(1)
    expect(r.map((x) => [x.provider, x.account])).toEqual([["claude", "c1"], ["codex", "work"], ["codex", "e@x"]])
    expect(pct5([r[0]!])).toBe(90)
    expect(pct5([r[1]!])).toBe(80)
    expect(r[2]!.error).toBe("boom")
  })
})

describe("backoff and stale values", () => {
  test("failure keeps last good values and pauses the account", async () => {
    clearCache()
    setMinInterval("codex", undefined) // isolate backoff from the min interval
    const s: CodexState = { calls: 0, used: 30 }
    const api = mkApi(s)
    expect(pct5(await fetchAllQuotas(api, "k", true, t0))).toBe(70)

    s.err = "upstream HTTP 429"
    const stale = await fetchAllQuotas(api, "k", true, t0 + 60_000)
    expect(stale[0]!.error).toBeUndefined()
    expect(stale[0]!.staleSince).toBeDefined()
    expect(pct5(stale)).toBe(70)
    expect(compactLine(CPA_PROVIDERS, stale, "codex")).toStartWith("codex 5h 70%")

    // Within the backoff window the account is not refreshed, even with force.
    s.err = undefined
    s.used = 10
    const paused = await fetchAllQuotas(api, "k", true, t0 + 2 * 60_000)
    expect(pct5(paused)).toBe(70)
    expect(paused[0]!.staleSince).toBeDefined()

    // Backoff over: retried; it fails again (2nd failure → longer pause).
    // The 5h window has reset by now, so the stale view shows it full.
    s.err = "upstream HTTP 429"
    const t61 = t0 + 61 * 60_000
    const later = await fetchAllQuotas(api, "k", true, t61)
    expect(pct5(later)).toBe(100)

    // Retry after the doubled pause succeeds and clears stale state.
    s.err = undefined
    const fresh = await fetchAllQuotas(api, "k", true, t61 + backoffMs(2) + 1)
    expect(fresh[0]!.staleSince).toBeUndefined()
    expect(pct5(fresh)).toBe(90)
    setMinInterval("codex", 15 * 60_000)
  })

  test("min interval skips the account even with force, values are not stale", async () => {
    clearCache()
    setMinInterval("codex", 15 * 60_000)
    const s: CodexState = { calls: 0, used: 30 }
    const api = mkApi(s)
    await fetchAllQuotas(api, "m", true, t0)
    s.used = 50
    const again = await fetchAllQuotas(api, "m", true, t0 + 60_000)
    expect(again[0]!.staleSince).toBeUndefined()
    expect(again[0]!.error).toBeUndefined()
    expect(pct5(again)).toBe(70)
    expect(pct5(await fetchAllQuotas(api, "m", true, t0 + 15 * 60_000 + 1))).toBe(50)
  })

  describe("persistence", () => {
    let dir: string
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "cpa-quota-test-"))
    })
    afterAll(() => {
      setStatePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    })

    test("state survives a restart", async () => {
      setMinInterval("codex", 15 * 60_000)
      setStatePath(join(dir, "sub", "state.json"))
      clearCache()
      const s: CodexState = { calls: 0, used: 30 }
      const api = mkApi(s)
      await fetchAllQuotas(api, "p", true, t0)

      // "restart": drop in-memory state, reload from file
      clearCache()
      s.used = 50
      const r = await fetchAllQuotas(api, "p", true, t0 + 60_000)
      expect(pct5(r)).toBe(70) // min interval honored from disk
      expect(r[0]!.windows[0]!.resetsAt).toBeInstanceOf(Date)
      expect(r[0]!.staleSince).toBeUndefined()

      // failure persists the pause too
      s.err = "upstream HTTP 429"
      await fetchAllQuotas(api, "p", true, t0 + 16 * 60_000)
      clearCache()
      s.err = undefined
      s.used = 10
      const after = await fetchAllQuotas(api, "p", true, t0 + 17 * 60_000)
      expect(pct5(after)).toBe(70)
      expect(after[0]!.staleSince).toBeDefined()
      setStatePath(undefined)
    })
  })

  test("backoff grows and caps", () => {
    expect(backoffMs(1)).toBe(5 * 60_000)
    expect(backoffMs(2)).toBe(10 * 60_000)
    expect(backoffMs(10)).toBe(30 * 60_000)
  })
})

// ---------- shared store, cross-process pauses ----------
describe("process-wide store", () => {
  test("separately imported module copies share state", async () => {
    setStatePath(undefined)
    clearCache()
    setMinInterval("codex", 15 * 60_000)
    const c1: any = await import(("../../base.ts?copy=1") as string)
    const c2: any = await import(("../../base.ts?copy=2") as string)
    const s: CodexState = { calls: 0, used: 30 }
    getStore().registry.sources.clear()
    registerQuotaSource(createCpaSource(mkApi(s)))
    await c1.fetchAllQuotas(true, t0)
    s.used = 60
    const r = await c2.fetchAllQuotas(true, t0 + 60_000)
    expect(pct5(r.accounts)).toBe(70)
    const store = (globalThis as any)[Symbol.for("opencode-cpa-quota.state")]
    expect(store.accountState.has("cpa:codex:1")).toBe(true)
    setMinInterval("codex", undefined)
  })

  describe("cross-process", () => {
    let dir: string
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "cpa-quota-xproc-"))
    })
    afterAll(() => {
      setStatePath(undefined)
      rmSync(dir, { recursive: true, force: true })
    })

    test("pause written by another process is honored", async () => {
      const path = join(dir, "state.json")
      setStatePath(path)
      clearCache()
      setMinInterval("codex", undefined)
      const s: CodexState = { calls: 0, used: 30 }
      const api = mkApi(s)
      await fetchAllQuotas(api, "xp", true, t0)
      // another process records a failure with a future pause
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          accounts: {
            "cpa:codex:1": { failures: 2, nextAttemptAt: t0 + 3_600_000, lastError: "upstream HTTP 429", failedAt: t0 + 1000, lastRequestAt: t0 + 1000 },
          },
        }),
      )
      s.used = 60
      const r = await fetchAllQuotas(api, "xp", true, t0 + 120_000)
      expect(pct5(r)).toBe(70)
      expect(r[0]!.staleSince).toBeDefined()
      setStatePath(undefined)
    })
  })

  test("only one interval timer per process across plugin setups", async () => {
    process.env.CPA_QUOTA_KEY = "k"
    const realFetch = globalThis.fetch
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    let live = 0
    let created = 0
    const timers = new Set<unknown>()
    globalThis.fetch = (async () => new Response(JSON.stringify({}))) as any
    globalThis.setInterval = ((fn: any, ms: any) => {
      const t = realSet(fn, 1e9)
      timers.add(t)
      live++
      created++
      return t
    }) as any
    globalThis.clearInterval = ((t: any) => {
      if (timers.delete(t)) live--
      realClear(t)
    }) as any
    try {
      const mod: any = (await import(("../../server.ts?timers=1") as string)).default
      const mod2: any = (await import(("../../server.ts?timers=2") as string)).default
      const mkCtx = () => ({
        options: { url: "https://cpa.test" },
        rpc: { register: async () => ({ events: { emit: async () => {} }, dispose() {} }) },
      })
      const d1 = await mod.setup(mkCtx())
      const d2 = await mod2.setup(mkCtx())
      expect(created).toBe(1)
      expect(live).toBe(1)
      // different config replaces the timer rather than adding one
      const ctx3 = { ...mkCtx(), options: { url: "https://other.test" } }
      const d3 = await mod2.setup(ctx3)
      expect(live).toBe(1)
      d1()
      d2()
      expect(live).toBe(1)
      d3()
      expect(live).toBe(0)
      expect((globalThis as any)[Symbol.for("opencode-cpa-quota.state")].poller).toBeUndefined()
    } finally {
      globalThis.fetch = realFetch
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
      for (const t of timers) realClear(t as any)
    }
  })
})

describe("claude from quota response", () => {
  const now = Date.parse("2026-10-08T10:00:00Z")
  const iso = (ms: number) => new Date(ms).toISOString()
  const mk = (claude: () => any, calls: { n: number } = { n: 0 }): Api => ({
    quota: async () => (calls.n++, { claude: claude(), codex: [] }),
  })
  const fresh = iso(now - 60_000)

  test("maps windows, rollover, extra, rejected, stale, missing", async () => {
    clearCache()
    const status = {
      accounts: [
        {
          auth_index: "a",
          windows: [
            { scope: "sonnet_weekly", percent_used: 40, reset_at: iso(now + 1e6), sampled_at: fresh },
            { scope: "weekly", percent_used: 25, reset_at: iso(now + 2e6), sampled_at: fresh },
            { scope: "five_hour", percent_used: 12, reset_at: iso(now + 3e6), sampled_at: fresh },
            { scope: "fable_weekly", percent_used: 10, reset_at: iso(now - 1000), sampled_at: fresh },
            { scope: "opus_weekly", percent_used: 150, sampled_at: fresh },
            { scope: "haiku_weekly", percent_used: 5, sampled_at: fresh },
          ],
          extra_usage: { percent_used: 4.6, reset_at: iso(now + 5e6), status: "allowed", enabled: true, used_credits: 4575, monthly_limit: 100000, currency: "USD", decimal_places: 2, sampled_at: fresh },
        },
        {
          auth_index: "b",
          windows: [{ scope: "five_hour", percent_used: 50, sampled_at: iso(now - 20 * 60_000) }],
          extra_usage: { percent_used: 100, status: "rejected", enabled: true, used_credits: 4575, monthly_limit: 100000, sampled_at: iso(now - 20 * 60_000) },
          last_refresh_error: "rate_limited: HTTP 429",
        },
        { auth_index: "c", windows: [], last_refresh_error: "boom" },
        { auth_index: "d" },
      ],
    }
    const r = await fetchAllQuotas(mk(() => status), "cl", true, now)
    expect(r.every((x) => x.provider === "claude")).toBe(true)
    expect(r[0]!.windows.map((w) => [w.label, w.remainingPct, w.detail])).toEqual([
      ["5h", 88, undefined],
      ["7d", 75, undefined],
      ["7d fable", 100, undefined],
      ["7d opus", 0, undefined],
      ["7d sonnet", 60, undefined],
      ["haiku weekly", 95, undefined],
      ["extra", 95.4, "$45.75 / $1000.00"],
    ])
    expect(r[0]!.windows[0]!.resetsAt?.getTime()).toBe(now + 3e6)
    expect(r[0]!.staleSince).toBeUndefined()
    expect(r[1]!.staleSince?.getTime()).toBe(now - 20 * 60_000)
    expect(r[1]!.staleReason).toBe("rate_limited: HTTP 429")
    expect(r[1]!.windows.at(-1)!.detail).toBe("$45.75 / $1000.00 · rejected")
    expect(r[2]!.error).toBe("boom")
    expect(r[3]!.error).toBe("no quota data yet")
    expect(mapRouterAccount({ provider: "claude", account: "x" }, { extra_usage: { enabled: false } }, now).error).toBe("no quota data yet")
  })

  test("quota is requested once per poll for all accounts", async () => {
    clearCache()
    const calls = { n: 0 }
    await fetchAllQuotas(mk(() => ({ accounts: [{ auth_index: "a" }, { auth_index: "b" }] }), calls), "cl2", true, now)
    expect(calls.n).toBe(1)
  })
})
