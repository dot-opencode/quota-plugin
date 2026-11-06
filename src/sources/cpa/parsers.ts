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

// ---------- claude (raw OAuth usage from quota-api) ----------
/** Formats an amount given in minor units (cents), e.g. 1234 → "$12.34". */
function money(minor: number, currency = "USD", decimals = 2): string {
  const v = (minor / 10 ** decimals).toFixed(decimals)
  return currency.toUpperCase() === "USD" ? `$${v}` : `${v} ${currency.toUpperCase()}`
}

const CLAUDE_SCOPES: [string, string][] = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_fable", "7d fable"],
  ["seven_day_opus", "7d opus"],
  ["seven_day_sonnet", "7d sonnet"],
]
const CLAUDE_STALE_MS = 15 * 60_000

function rolled(label: string, pct: number, resetsAt: Date | undefined, now: number): QuotaWindow {
  if (resetsAt && resetsAt.getTime() <= now) return { label, remainingPct: 100 }
  return { label, remainingPct: clamp(100 - pct), resetsAt }
}

function claudeExtra(e: any): QuotaWindow | undefined {
  if (!e || typeof e !== "object" || e.is_enabled !== true) return undefined
  const used = num(e.used_credits)
  const limit = num(e.monthly_limit)
  const hasAmounts = used !== undefined && used >= 0 && limit !== undefined && limit > 0
  let pct = num(e.utilization)
  if (pct !== undefined && pct < 0) pct = undefined
  if (pct === undefined && hasAmounts) pct = (used / limit) * 100
  if (pct === undefined) return undefined
  const w: QuotaWindow = { label: "extra", remainingPct: clamp(100 - pct) }
  const currency = typeof e.currency === "string" && e.currency ? e.currency : "USD"
  const places = num(e.decimal_places)
  const decimals = places !== undefined && Number.isInteger(places) && places >= 0 && places <= 6 ? places : 2
  if (hasAmounts) w.detail = `${money(used, currency, decimals)} / ${money(limit, currency, decimals)}`
  return w
}

function scopedFamily(model: any): string | undefined {
  const tokens = [model?.id, model?.display_name]
    .filter((v): v is string => typeof v === "string")
    .join(" ").toLowerCase().split(/[^a-z0-9]+/)
  const families = ["fable", "opus", "sonnet"].filter(f => tokens.includes(f))
  return families.length === 1 ? families[0] : undefined
}

/** Maps one Claude quota-api entry, including server-cached usage on refresh errors. */
export function mapClaudeAccount(base: { provider: string; account: string }, a: any, now: number): AccountQuota & { retryAfterMs?: number } {
  const usage = a?.usage
  type WindowValue = { pct: number; resetsAt?: Date }
  const value = (w: any, newer = false): WindowValue | undefined => {
    const pct = num(newer ? pick(w, "percent", "utilization") : w?.utilization)
    if (pct === undefined) return undefined
    // A missing reset is allowed; a malformed window must not override legacy data.
    const resetsAt = typeof w?.resets_at === "string" ? date(w.resets_at) : undefined
    if (w?.resets_at !== undefined && w.resets_at !== null && !resetsAt) return undefined
    return { pct: clamp(pct), resetsAt }
  }
  const newer = new Map<string, WindowValue>()
  for (const w of Array.isArray(usage?.limits) ? usage.limits : []) {
    const kind = typeof w?.kind === "string" ? w.kind.trim().toLowerCase() : ""
    const family = kind === "weekly_scoped" ? scopedFamily(w?.scope?.model) : undefined
    const key = kind === "session" ? "five_hour" : kind === "weekly_all" ? "seven_day" : family ? `seven_day_${family}` : undefined
    const next = value(w, true)
    if (!key || !next) continue
    const prior = newer.get(key)
    if (prior) {
      next.pct = Math.max(prior.pct, next.pct)
      next.resetsAt = prior.resetsAt && next.resetsAt
        ? new Date(Math.max(prior.resetsAt.getTime(), next.resetsAt.getTime())) : undefined
    }
    newer.set(key, next)
  }
  const windows: QuotaWindow[] = []
  for (const [key, label] of CLAUDE_SCOPES) {
    const w = newer.get(key) ?? value(usage?.[key])
    if (w) windows.push(rolled(label, w.pct, w.resetsAt, now))
  }
  const extra = claudeExtra(usage?.extra_usage)
  if (extra) windows.push(extra)
  const error = typeof a?.error === "string" && a.error ? a.error : undefined
  if (!windows.length) {
    const retryAfterMs = typeof a?.retry_after_ms === "number" && Number.isFinite(a.retry_after_ms) && a.retry_after_ms > 0 ? a.retry_after_ms : undefined
    return { ...base, windows, error: error ?? "no quota data yet", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
  }
  const fetchedAt = typeof a?.fetched_at === "string" ? date(a.fetched_at) : undefined
  if (error || (fetchedAt && now - fetchedAt.getTime() > CLAUDE_STALE_MS)) {
    return { ...base, windows, staleSince: fetchedAt ?? new Date(now), staleReason: error }
  }
  return { ...base, windows }
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
