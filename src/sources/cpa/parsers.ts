import type { AccountQuota, QuotaWindow } from "../../types.ts"

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
