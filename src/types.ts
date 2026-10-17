export interface QuotaWindow {
  label: string
  remainingPct: number
  resetsAt?: Date
  /** Extra text shown after the percentage in /quota, e.g. "$12.34 / $50.00". */
  detail?: string
}

export interface AccountQuota {
  provider: string
  account: string
  plan?: string
  windows: QuotaWindow[]
  error?: string
  /** Set when the latest fetch failed: when the shown (last known good) `windows` were fetched. */
  staleSince?: Date
  /** Why the latest fetch failed (only with staleSince). */
  staleReason?: string
}
