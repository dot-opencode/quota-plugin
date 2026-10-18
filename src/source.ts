import { getStore } from "./store.ts"
import type { AccountQuota, QuotaWindow } from "./types.ts"

export type { AccountQuota, QuotaWindow }

export interface ProviderMeta {
  id: string
  name?: string
  /** OpenCode providerIDs mapping to this provider. */
  providerIDs?: string[]
  /** Lowercase model id prefixes. */
  modelPrefixes?: string[]
  /** RegExp source, matched case-insensitively. */
  modelPattern?: string
  /** Absolute path to a png. */
  logo?: string
  /** Default true; false = the base neither backs off nor applies minInterval for this provider. */
  backoff?: boolean
}

export interface AccountRef {
  provider: string
  key: string
  account: string
  data?: unknown
}

export type FetchResult = Omit<AccountQuota, "provider" | "account"> | { error: string; retryAfterMs?: number }

export interface QuotaSource {
  id: string
  providers: ProviderMeta[]
  listAccounts(): Promise<AccountRef[]>
  /** Keyed by `ref.key`. */
  fetch(refs: AccountRef[]): Promise<Map<string, FetchResult>>
  /** Non-undefined → stop polling this source; the message goes to snapshot.rejected. */
  fatal?(e: unknown): string | undefined
}

/**
 * Registers a quota source (replacing one with the same id). Returns an unregister function.
 * The registry lives on globalThis, so it works across module copies.
 */
export function registerQuotaSource(src: QuotaSource): () => void {
  const reg = getStore().registry
  reg.sources.set(src.id, src)
  reg.version++
  for (const l of [...reg.listeners]) l()
  return () => {
    if (reg.sources.get(src.id) !== src) return
    reg.sources.delete(src.id)
    reg.version++
    for (const l of [...reg.listeners]) l()
  }
}
