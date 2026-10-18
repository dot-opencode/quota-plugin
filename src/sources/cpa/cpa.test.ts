import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApiError, createApi, parseRetryAfter, isAuthRejection, normalizeProvider, parseAuthFiles, type Api } from "./api.ts"
import { loadConfig } from "./config.ts"
import { compactLine } from "../../format.ts"
import { backoffMs, clearCache, fetchAllQuotas as fetchAll, setMinInterval, setStatePath } from "../../base.ts"
import { registerQuotaSource } from "../../source.ts"
import { getStore } from "../../store.ts"
import { codexAccountId, parseAntigravity, mapRouterAccount, parseCodex, parseKimi } from "./parsers.ts"
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

const jwt = (payload: object) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`

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

  test("antigravity", () => {
    const w = parseAntigravity({
      groups: [{ displayName: "Gemini Pro", buckets: [{ window: "5h", remainingFraction: 0.5, resetTime: "2026-10-08T12:00:00Z" }] },
        { display_name: "Flash", buckets: [{ window: "7d", remaining_fraction: 1 }] }],
    })
    expect(w.map((x) => [x.label, x.remainingPct])).toEqual([["Gemini Pro 5h", 50], ["Flash 7d", 100]])
    expect(parseAntigravity({ groups: [] })).toEqual([])
  })

  test("kimi", () => {
    const w = parseKimi({
      usage: { limit: 100, remaining: 80, resetTime: "2026-10-10T00:00:00Z" },
      limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 10, remaining: 5 } }],
    })
    expect(w.map((x) => [x.label, x.remainingPct])).toEqual([["5h", 50], ["7d", 80]])
  })

  test("jwt account id", () => {
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } })
    expect(codexAccountId({ id_token: token })).toBe("acc-1")
    expect(codexAccountId({ id_token: undefined, metadata: { account_id: "m-1" } })).toBe("m-1")
    expect(codexAccountId({ id_token: "garbage" })).toBeUndefined()
  })
})

describe("api", () => {
  test("normalizeProvider", () => {
    expect(normalizeProvider("Anthropic")).toBe("claude")
    expect(normalizeProvider("anti_gravity")).toBe("antigravity")
    expect(normalizeProvider("grok")).toBe("xai")
    expect(normalizeProvider("x_ai")).toBe("xai")
  })
  test("parseAuthFiles", () => {
    const f = parseAuthFiles({
      files: [
        { name: "a", type: "anthropic", auth_index: "1" },
        { name: "b", provider: "codex", authIndex: "2", disabled: true },
        { name: "c", provider: "codex" },
        { name: "d", account_type: "kimi", auth_index: "4", email: "x@y" },
      ],
    })
    expect(f.map((x) => [x.provider, x.auth_index])).toEqual([["claude", "1"], ["kimi", "4"]])
  })
  test("config", () => {
    expect(loadConfig({}, { CPA_MANAGEMENT_URL: "https://x.io/", CPA_MANAGEMENT_KEY: "k" })).toEqual({ url: "https://x.io", key: "k", refreshSec: 300 })
    expect(loadConfig({ refreshSec: 30, url: "https://o.io//" }, {}).url).toBe("https://o.io")
    expect(loadConfig({}, { CPA_MANAGEMENT_KEY: "k" }).url).toBeUndefined()
  })
})

const noRouter = async (): Promise<any> => {
  throw new Error("routerStatus must not be called")
}

const acc = (provider: string, account: string, r5: number, r7: number, extra: Partial<AccountQuota> = {}): AccountQuota => ({
  provider,
  account,
  windows: [{ label: "5h", remainingPct: r5 }, { label: "7d", remainingPct: r7 }],
  ...extra,
})

describe("auth rejection", () => {
  const files = [{ provider: "codex", auth_index: "1", raw: {} }]
  const api = (err: unknown): Api => ({
    routerStatus: noRouter,
    listAuthFiles: async () => files,
    apiCall: async () => {
      throw err
    },
  })

  test("management 401/403 propagates so polling can stop", async () => {
    clearCache()
    const err = new ApiError("api-call HTTP 403", 403, true)
    const r = await poll(api(err))
    expect(r.rejected).toBe("cpa: access denied (403)")
    clearCache()
    const listErr = new ApiError("auth-files HTTP 401", 401, true)
    const bad: Api = { routerStatus: noRouter, listAuthFiles: async () => { throw listErr }, apiCall: async () => null }
    expect((await poll(bad)).rejected).toBe("cpa: invalid key (401)")
  })

  test("upstream provider 401/403 stays a per-account error", async () => {
    clearCache()
    const data = await fetchAllQuotas(api(new ApiError("upstream HTTP 401", 401)), "t3", true)
    expect(data[0]!.error).toContain("upstream HTTP 401")
    expect(isAuthRejection(new ApiError("x", 403))).toBe(false)
    expect(isAuthRejection(new ApiError("x", 500, true))).toBe(false)
  })
})

describe("backoff and stale values", () => {
  const files = [{ provider: "codex", auth_index: "1", email: "a", raw: {} }]
  const t0 = Date.parse("2026-10-08T10:00:00Z")
  const usage = {
    rate_limit: {
      primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: (t0 + 60 * 60000) / 1000 },
      secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: (t0 + 3 * 86400000) / 1000 },
    },
  }

  test("429 keeps last good values and pauses the account", async () => {
    clearCache()
    setMinInterval("codex", undefined) // isolate backoff from the min interval
    let calls = 0
    let fail = false
    const api: Api = {
      routerStatus: noRouter,
      listAuthFiles: async () => files,
      apiCall: async () => {
        calls++
        if (fail) throw new ApiError("upstream HTTP 429", 429)
        return usage
      },
    }
    const ok = await fetchAllQuotas(api, "k", true, t0)
    expect(ok[0]!.windows[0]!.remainingPct).toBe(70)
    expect(calls).toBe(1)

    fail = true
    const stale = await fetchAllQuotas(api, "k", true, t0 + 60_000)
    expect(calls).toBe(2)
    expect(stale[0]!.error).toBeUndefined()
    expect(stale[0]!.staleSince).toBeDefined()
    expect(stale[0]!.windows[0]!.remainingPct).toBe(70)
    expect(compactLine(CPA_PROVIDERS, stale, "codex")).toStartWith("codex 5h 70%")

    // Within the backoff window: no upstream call, even with force.
    await fetchAllQuotas(api, "k", true, t0 + 2 * 60_000)
    expect(calls).toBe(2)

    // Backoff over: retried; it fails again (2nd failure → longer pause).
    // The 5h window has reset by now, so the stale view shows it full.
    const t61 = t0 + 61 * 60_000
    const later = await fetchAllQuotas(api, "k", true, t61)
    expect(calls).toBe(3)
    expect(later[0]!.windows.find((w) => w.label === "5h")!.remainingPct).toBe(100)

    // Retry after the doubled pause succeeds and clears stale state.
    fail = false
    const fresh = await fetchAllQuotas(api, "k", true, t61 + backoffMs(2) + 1)
    expect(calls).toBe(4)
    expect(fresh[0]!.staleSince).toBeUndefined()
    setMinInterval("codex", 15 * 60_000)
  })

  const mkApi = (state: { calls: number; err?: ApiError }): Api => ({
    routerStatus: noRouter,
    listAuthFiles: async () => files,
    apiCall: async () => {
      state.calls++
      if (state.err) throw state.err
      return usage
    },
  })

  test("min interval skips the request even with force, values are not stale", async () => {
    clearCache()
    setMinInterval("codex", 15 * 60_000)
    const s = { calls: 0 }
    const api = mkApi(s)
    await fetchAllQuotas(api, "m", true, t0)
    const again = await fetchAllQuotas(api, "m", true, t0 + 60_000)
    expect(s.calls).toBe(1)
    expect(again[0]!.staleSince).toBeUndefined()
    expect(again[0]!.error).toBeUndefined()
    expect(again[0]!.windows[0]!.remainingPct).toBe(70)
    await fetchAllQuotas(api, "m", true, t0 + 15 * 60_000 + 1)
    expect(s.calls).toBe(2)
  })

  test("Retry-After extends the pause", async () => {
    clearCache()
    setMinInterval("codex", undefined)
    const s: { calls: number; err?: ApiError } = { calls: 0 }
    const api = mkApi(s)
    await fetchAllQuotas(api, "r", true, t0)
    s.err = new ApiError("upstream HTTP 429", 429, false, 60 * 60_000)
    await fetchAllQuotas(api, "r", true, t0 + 1000)
    expect(s.calls).toBe(2)
    await fetchAllQuotas(api, "r", true, t0 + 1000 + 30 * 60_000) // past 5 min backoff, inside Retry-After
    expect(s.calls).toBe(2)
    await fetchAllQuotas(api, "r", true, t0 + 1000 + 60 * 60_000 + 1)
    expect(s.calls).toBe(3)
    setMinInterval("codex", 15 * 60_000)
  })

  test("parseRetryAfter", () => {
    expect(parseRetryAfter({ "Retry-After": ["120"] })).toBe(120_000)
    expect(parseRetryAfter({ "retry-after": "7" })).toBe(7000)
    const now = Date.parse("2026-10-08T10:00:00Z")
    expect(parseRetryAfter({ "RETRY-AFTER": "Thu, 08 Oct 2026 10:01:00 GMT" }, now)).toBe(60_000)
    expect(parseRetryAfter({ foo: "1" })).toBeUndefined()
    expect(parseRetryAfter(undefined)).toBeUndefined()
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
      const s: { calls: number; err?: ApiError } = { calls: 0 }
      const api = mkApi(s)
      await fetchAllQuotas(api, "p", true, t0)
      expect(s.calls).toBe(1)

      // "restart": drop in-memory state, reload from file
      clearCache()
      const r = await fetchAllQuotas(api, "p", true, t0 + 60_000)
      expect(s.calls).toBe(1)
      expect(r[0]!.windows[0]!.remainingPct).toBe(70)
      expect(r[0]!.windows[0]!.resetsAt).toBeInstanceOf(Date)
      expect(r[0]!.staleSince).toBeUndefined()

      // failure persists the pause too
      s.err = new ApiError("upstream HTTP 429", 429)
      await fetchAllQuotas(api, "p", true, t0 + 16 * 60_000)
      expect(s.calls).toBe(2)
      clearCache()
      const after = await fetchAllQuotas(api, "p", true, t0 + 17 * 60_000)
      expect(s.calls).toBe(2)
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

// ---------- shared store, cross-process pauses, router-backed claude ----------
describe("process-wide store", () => {
  const t0 = Date.parse("2026-10-08T10:00:00Z")
  const codexFiles = [{ provider: "codex", auth_index: "1", email: "a", raw: {} }]
  const usage = { rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000 } } }
  const mk = (s: { calls: number }): Api => ({
    routerStatus: noRouter,
    listAuthFiles: async () => codexFiles,
    apiCall: async () => {
      s.calls++
      return usage
    },
  })

  test("separately imported module copies share state", async () => {
    setStatePath(undefined)
    clearCache()
    setMinInterval("codex", 15 * 60_000)
    const c1: any = await import(("../../base.ts?copy=1") as string)
    const c2: any = await import(("../../base.ts?copy=2") as string)
    const s = { calls: 0 }
    const api = mk(s)
    getStore().registry.sources.clear()
    registerQuotaSource(createCpaSource(api))
    await c1.fetchAllQuotas(true, t0)
    await c2.fetchAllQuotas(true, t0 + 60_000)
    expect(s.calls).toBe(1)
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
      const s = { calls: 0 }
      const api = mk(s)
      await fetchAllQuotas(api, "xp", true, t0)
      expect(s.calls).toBe(1)
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
      const r = await fetchAllQuotas(api, "xp", true, t0 + 120_000)
      expect(s.calls).toBe(1)
      expect(r[0]!.windows[0]!.remainingPct).toBe(70)
      expect(r[0]!.staleSince).toBeDefined()
      setStatePath(undefined)
    })
  })

  test("only one interval timer per process across plugin setups", async () => {
    process.env.CPA_MANAGEMENT_KEY = "k"
    const realFetch = globalThis.fetch
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    let live = 0
    let created = 0
    const timers = new Set<unknown>()
    globalThis.fetch = (async () => new Response(JSON.stringify({ files: [] }))) as any
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

describe("claude from router status", () => {
  const now = Date.parse("2026-10-08T10:00:00Z")
  const iso = (ms: number) => new Date(ms).toISOString()
  const cf = (idx: string, email = idx) => ({ provider: "claude", auth_index: idx, email, raw: {} })
  const mk = (files: any[], status: () => Promise<any>, apiCalls: string[] = []): Api => ({
    listAuthFiles: async () => files,
    routerStatus: status,
    apiCall: async (i) => {
      apiCalls.push(i.url)
      return {}
    },
  })
  const fresh = iso(now - 60_000)

  test("maps windows, rollover, extra, rejected, stale, missing", async () => {
    clearCache()
    const calls: string[] = []
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
    const files = [cf("a"), cf("b"), cf("c"), cf("d"), cf("zzz")]
    const r = await fetchAllQuotas(mk(files, async () => status, calls), "cl", true, now)
    expect(calls).toEqual([])
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
    expect(r[4]!.error).toBe("not in router status")
    expect(mapRouterAccount({ provider: "claude", account: "x" }, { extra_usage: { enabled: false } }, now).error).toBe("no quota data yet")
  })

  test("router status is requested once for all claude accounts", async () => {
    clearCache()
    let n = 0
    await fetchAllQuotas(mk([cf("a"), cf("b")], async () => (n++, { accounts: [] })), "cl2", true, now)
    expect(n).toBe(1)
  })

  test("router 404 is a per-account error", async () => {
    clearCache()
    const calls: string[] = []
    const r = await fetchAllQuotas(
      mk([cf("a")], async () => { throw new ApiError("router status HTTP 404", 404, true) }, calls),
      "cl3", true, now,
    )
    expect(r[0]!.error).toBe("router status HTTP 404")
    expect(calls).toEqual([])
  })

  test("management 401 propagates", async () => {
    clearCache()
    const err = new ApiError("router status HTTP 401", 401, true)
    expect((await poll(mk([cf("a")], async () => { throw err }), true, now)).rejected).toBe("cpa: invalid key (401)")
  })

  test("createApi.routerStatus hits the plugin endpoint", async () => {
    const urls: string[] = []
    const fakeFetch = (async (u: string) => {
      urls.push(u)
      return new Response("{}", { status: 404 })
    }) as any
    const api = createApi({ url: "https://cpa.test", key: "k" }, fakeFetch)
    await expect(api.routerStatus()).rejects.toMatchObject({ message: "router status HTTP 404", management: true })
    expect(urls).toEqual(["https://cpa.test/v0/management/plugins/five-hour-quota-router/status"])
  })
})
