import type { AccountQuota, QuotaWindow } from "./types.ts"

const PROVIDERS = ["claude", "codex", "antigravity", "kimi"]

export function providerForModel(modelID?: string, providerID?: string): string | undefined {
  if (providerID && PROVIDERS.includes(providerID)) return providerID
  const m = (modelID ?? "").toLowerCase().split("/").pop() ?? ""
  if (m.startsWith("claude")) return "claude"
  if (m.startsWith("gpt") || m.startsWith("codex") || /^o[134](\b|-|$)/.test(m)) return "codex"
  if (m.startsWith("gemini")) return "antigravity"
  if (m.startsWith("kimi")) return "kimi"
  return undefined
}

export function formatReset(resetsAt: Date, now = Date.now()): string {
  const mins = Math.max(0, Math.round((resetsAt.getTime() - now) / 60000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** "just now" or e.g. "12m ago". */
const ago = (since: Date, now: number) =>
  now - since.getTime() < 60_000 ? "just now" : `${formatReset(new Date(now), since.getTime())} ago`

const pct = (n: number) => `${Math.round(n)}%`

/** Main windows: 5h and 7d if present, else first two. */
function mainWindows(ws: QuotaWindow[]): QuotaWindow[] {
  const main = ws.filter((w) => w.label === "5h" || w.label === "7d")
  return main.length ? main : ws.slice(0, 2)
}

/**
 * Semantic role of a piece of the status line; the TUI maps it to a theme token.
 * - provider: provider names (all alike)   - label: window labels, separators
 * - ok / warn / critical: remaining % by threshold
 * - empty: quota exhausted (0%)      - stale: last-known marker, n/a
 */
export type Tone = "provider" | "label" | "ok" | "warn" | "critical" | "empty" | "stale"
export interface Segment {
  text: string
  tone: Tone
  /** Set on provider-name segments: provider id (the TUI may render a logo instead of `text`). */
  provider?: string
}

export const WARN_BELOW = 20
export const CRITICAL_BELOW = 5

export function toneFor(remainingPct: number): Tone {
  if (remainingPct <= 0) return "empty"
  if (remainingPct < CRITICAL_BELOW) return "critical"
  if (remainingPct < WARN_BELOW) return "warn"
  return "ok"
}

const seg = (text: string, tone: Tone): Segment => ({ text, tone })

function windowSegments(ws: QuotaWindow[], now: number): Segment[] {
  const out: Segment[] = []
  mainWindows(ws).forEach((w, i) => {
    if (i > 0) out.push(seg(" · ", "label"))
    out.push(seg(`${w.label} `, "label"), seg(pct(w.remainingPct), toneFor(w.remainingPct)))
    if (w.label === "5h" && w.resetsAt && w.remainingPct < 99.5) out.push(seg(` (${formatReset(w.resetsAt, now)})`, "label"))
  })
  return out
}

const minRemaining = (a: AccountQuota) =>
  a.windows.length ? Math.min(...mainWindows(a.windows).map((w) => w.remainingPct)) : Infinity

/** Stale (last-known) values are shown as-is; details are in /quota. */
function accountSegments(a: AccountQuota | undefined, now: number): Segment[] {
  if (!a || a.error || !a.windows.length) return [seg("n/a", "stale")]
  return windowSegments(a.windows, now)
}

/**
 * All providers on one line. The active provider (if any) goes first and shows
 * every account; other providers show only their most-depleted account.
 */
export function compactSegments(accounts: AccountQuota[], activeProvider?: string, now = Date.now()): Segment[] {
  const providers = activeProvider
    ? [activeProvider, ...PROVIDERS.filter((p) => p !== activeProvider)]
    : PROVIDERS
  const out: Segment[] = []
  for (const p of providers) {
    const accts = accounts.filter((a) => a.provider === p)
    if (!accts.length) continue
    if (out.length) out.push(seg(" ", "label"))
    out.push({ ...seg(`${p} `, "provider"), provider: p })
    if (p === activeProvider && accts.length > 1) {
      // Accounts of one provider are separated by " / " (providers by spaces).
      accts.forEach((a, i) => {
        if (i > 0) out.push(seg(" / ", "label"))
        out.push(...accountSegments(a, now))
      })
    } else {
      const ok = accts.filter((a) => !a.error && a.windows.length)
      const worst = ok.sort((a, b) => minRemaining(a) - minRemaining(b))[0]
      out.push(...accountSegments(worst, now))
    }
  }
  return out
}

export function compactLine(accounts: AccountQuota[], activeProvider?: string, now = Date.now()): string {
  return compactSegments(accounts, activeProvider, now).map((s) => s.text).join("")
}

export interface ReportWindow {
  label: string
  /** Remaining, e.g. "42%". */
  pct: string
  remainingPct: number
  tone: Tone
  /** e.g. "2h 5m"; set only when the window is not full. */
  reset?: string
  /** e.g. "$12.34 / $50.00". */
  detail?: string
}
export interface ReportAccount {
  account: string
  plan?: string
  windows: ReportWindow[]
  error?: string
  /** e.g. "updated 12m ago" — set when values are last known, not fresh. */
  stale?: string
}
export interface ReportGroup {
  provider: string
  accounts: ReportAccount[]
}

/** Structured version of fullReport, grouped by provider (known providers first). */
export function reportGroups(accounts: AccountQuota[], now = Date.now()): ReportGroup[] {
  const order = [...PROVIDERS, ...accounts.map((a) => a.provider).filter((p) => !PROVIDERS.includes(p))]
  const groups: ReportGroup[] = []
  for (const provider of new Set(order)) {
    const accts = accounts.filter((a) => a.provider === provider)
    if (!accts.length) continue
    groups.push({
      provider,
      accounts: accts.map((a) => ({
        account: a.account,
        plan: a.plan,
        error: a.error,
        windows: a.error
          ? []
          : a.windows.map((w) => ({
              label: w.label,
              pct: pct(w.remainingPct),
              remainingPct: w.remainingPct,
              tone: toneFor(w.remainingPct),
              reset: w.resetsAt && w.remainingPct < 99.5 ? formatReset(w.resetsAt, now) : undefined,
              detail: w.detail,
            })),
        stale: a.staleSince && !a.error ? `updated ${ago(a.staleSince, now)}` : undefined,
      })),
    })
  }
  return groups
}

/** Filled cells of a `width`-cell bar for a remaining percentage (at least 1 when not empty). */
export function barFill(remainingPct: number, width: number): number {
  if (remainingPct <= 0) return 0
  return Math.min(width, Math.max(1, Math.round((remainingPct / 100) * width)))
}

export function fullReport(accounts: AccountQuota[], now = Date.now()): string {
  if (!accounts.length) return "No accounts found."
  return accounts
    .map((a) => {
      const head = [a.provider, a.account, a.plan].filter(Boolean).join(" · ")
      const lines = a.error
        ? [`  error: ${a.error}`]
        : a.windows.length
          ? a.windows.map((w) => {
              const reset = w.resetsAt && w.remainingPct < 99.5 ? `  resets in ${formatReset(w.resetsAt, now)}` : ""
              const detail = w.detail ? `  ${w.detail}` : ""
              return `  ${w.label.padEnd(12)} ${pct(w.remainingPct).padStart(4)}${detail}${reset}`
            })
          : ["  no quota data"]
      if (a.staleSince && !a.error) lines.push(`  (updated ${ago(a.staleSince, now)})`)
      return [head, ...lines].join("\n")
    })
    .join("\n\n")
}
