import type { Api } from "./api.ts"
import type { Config } from "./config.ts"
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
  config: Config
  api?: Api
  snapshot: Snapshot
  timer?: ReturnType<typeof setInterval>
  inflight?: Promise<void>
  listeners: Set<Listener>
}

export interface Store {
  // providers.ts
  accountState: Map<string, AccountState>
  minIntervals: Record<string, number>
  cache?: { at: number; key: string; data: AccountQuota[] }
  inflight?: { key: string; p: Promise<AccountQuota[]> }
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
  return (g[STORE_KEY] ??= {
    accountState: new Map(),
    minIntervals: {},
    loaded: false,
    statePathSet: false,
  } satisfies Store)
}
