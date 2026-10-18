import type { ProviderMeta } from "./source.ts"
import type { AccountQuota } from "./types.ts"

/** JSON-safe form of AccountQuota: Dates travel as epoch milliseconds. */
export interface WireWindow {
  label: string
  remainingPct: number
  resetsAt?: number
  detail?: string
}

export interface WireAccount {
  provider: string
  account: string
  plan?: string
  windows: readonly WireWindow[]
  error?: string
  staleSince?: number
  staleReason?: string
}

export interface WireSnapshot {
  configured: boolean
  accounts?: readonly WireAccount[]
  failed: boolean
  rejected?: string
  providers?: readonly WireProvider[]
}

export interface WireProvider {
  id: string
  name?: string
  providerIDs?: readonly string[]
  modelPrefixes?: readonly string[]
  modelPattern?: string
  logo?: string
  backoff?: boolean
}

export interface Snapshot {
  configured: boolean
  accounts?: AccountQuota[]
  failed: boolean
  rejected?: string
  providers?: ProviderMeta[]
}

const ms = (d: Date | undefined) => (d ? d.getTime() : undefined)
const date = (n: number | undefined) => (n === undefined || n === null ? undefined : new Date(n))

/** Builds objects without keys whose value is undefined (the wire schema has optional, not `| undefined`, fields). */
const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

export function toWire(s: Snapshot): WireSnapshot {
  return clean({
    configured: s.configured,
    failed: s.failed,
    rejected: s.rejected,
    providers: s.providers?.map((p) => clean({ ...p, providerIDs: p.providerIDs && [...p.providerIDs], modelPrefixes: p.modelPrefixes && [...p.modelPrefixes] })),
    accounts: s.accounts?.map((a) =>
      clean({
        provider: a.provider,
        account: a.account,
        plan: a.plan,
        error: a.error,
        staleSince: ms(a.staleSince),
        staleReason: a.staleReason,
        windows: a.windows.map((w) => clean({ label: w.label, remainingPct: w.remainingPct, resetsAt: ms(w.resetsAt), detail: w.detail })),
      }),
    ),
  })
}

export function fromWire(w: WireSnapshot): Snapshot {
  return {
    configured: w.configured,
    failed: w.failed,
    rejected: w.rejected,
    providers: w.providers?.map((p) => clean({ ...p, providerIDs: p.providerIDs && [...p.providerIDs], modelPrefixes: p.modelPrefixes && [...p.modelPrefixes] })),
    accounts: w.accounts?.map((a) => ({
      provider: a.provider,
      account: a.account,
      plan: a.plan,
      error: a.error,
      staleSince: date(a.staleSince),
      staleReason: a.staleReason,
      windows: a.windows.map((x) => ({ label: x.label, remainingPct: x.remainingPct, resetsAt: date(x.resetsAt), detail: x.detail })),
    })),
  }
}
