import type { FetchAllResult } from "./base.ts"
import type { QuotaSource } from "./source.ts"
import type { Snapshot } from "./snapshot.ts"
import type { AccountQuota } from "./types.ts"

export interface AccountState {
  lastGood?: AccountQuota
  /** When lastGood was fetched. */
  goodAt?: number
  failures: number
  nextAttemptAt: number
  lastError?: string
  failedAt?: number
  /** When the last upstream request was started. */
  lastRequestAt?: number
}

export type Listener = (s: Snapshot) => Promise<void>

export interface Poller {
  /** Identity of the built-in CPA source config (url|key|refreshSec); undefined when CPA isn't configured. */
  configKey: string
  refreshSec: number
  unregisterCpa?: () => void
  offRegistry?: () => void
  snapshot: Snapshot
  timer?: ReturnType<typeof setInterval>
  inflight?: Promise<void>
  listeners: Set<Listener>
}

export interface Registry {
  sources: Map<string, QuotaSource>
  listeners: Set<() => void>
  /** Bumped on every register/unregister; invalidates the result cache. */
  version: number
}

export interface Store {
  registry: Registry
  // base.ts
  /** Sources stopped by `fatal`, id → message. */
  rejected: Map<string, string>
  /** Last accounts per source, shown while a source is rejected or unlistable. */
  lastAccounts: Map<string, AccountQuota[]>
  accountState: Map<string, AccountState>
  minIntervals: Record<string, number>
  cache?: { at: number; version: number; data: FetchAllResult }
  inflight?: { version: number; p: Promise<FetchAllResult> }
  loaded: boolean
  statePath?: string
  statePathSet: boolean
  // server.ts
  poller?: Poller
}

export const STORE_KEY = Symbol.for("opencode-cpa-quota.state")

/**
 * The OpenCode server loads plugin modules many times, each copy with its own module
 * instance; all mutable state therefore lives on globalThis, shared by every copy.
 */
export function getStore(): Store {
  const g = globalThis as any
  const s = (g[STORE_KEY] ??= {}) as Partial<Store>
  // The store may have been created by an older plugin version in the same process
  // (e.g. after an in-place update), so fill in any field it lacks.
  s.registry ??= { sources: new Map(), listeners: new Set(), version: 0 }
  s.rejected ??= new Map()
  s.lastAccounts ??= new Map()
  s.accountState ??= new Map()
  s.minIntervals ??= {}
  s.loaded ??= false
  s.statePathSet ??= false
  return s as Store
}
