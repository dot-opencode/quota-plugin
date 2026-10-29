import { fileURLToPath } from "node:url"
import type { AccountRef, FetchResult, ProviderMeta, QuotaSource } from "../../source.ts"
import { ApiError, type Api, type CodexEntry, type QuotaResponse } from "./api.ts"
import { mapRouterAccount, parseCodex } from "./parsers.ts"

const logo = (id: string) => fileURLToPath(new URL(`../../../assets/${id}.png`, import.meta.url))

export const CPA_PROVIDERS: ProviderMeta[] = [
  { id: "claude", providerIDs: ["claude"], modelPrefixes: ["claude"], backoff: false, logo: logo("claude") },
  { id: "codex", providerIDs: ["codex"], modelPrefixes: ["gpt", "codex"], modelPattern: "^o[134](\\b|-|$)", logo: logo("codex") },
]

const CONFIG_ERROR_KEY = "__config_error__"

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)

function claudeRefs(res: QuotaResponse): AccountRef[] {
  const out: AccountRef[] = []
  for (const a of Array.isArray(res.claude?.accounts) ? res.claude.accounts : []) {
    if (a?.auth_index === undefined || a?.auth_index === null || String(a.auth_index) === "") continue
    const key = String(a.auth_index)
    out.push({ provider: "claude", key, account: str(a.email) ?? str(a.label) ?? str(a.name) ?? key, data: a })
  }
  return out
}

function codexRefs(res: QuotaResponse): AccountRef[] {
  const out: AccountRef[] = []
  for (const e of Array.isArray(res.codex) ? res.codex : []) {
    if (!e || e.auth_index === undefined || e.auth_index === null || String(e.auth_index) === "") continue
    const key = String(e.auth_index)
    out.push({ provider: "codex", key, account: str(e.email) ?? str(e.label) ?? key, data: e })
  }
  return out
}

function codexResult(e: CodexEntry): FetchResult {
  const error = str(e.error)
  const retryAfterMs = typeof e.retry_after_ms === "number" && e.retry_after_ms > 0 ? e.retry_after_ms : undefined
  if (e.usage === undefined || e.usage === null) return { error: error ?? "no usage data", retryAfterMs }
  const parsed = parseCodex(e.usage)
  // Usage plus error: the base keeps showing the last known values and backs off.
  return error ? ({ ...parsed, error, retryAfterMs } as FetchResult) : parsed
}

export function createCpaSource(api: Api, id = "cpa", clock: () => number = Date.now): QuotaSource {
  // One request per poll: listAccounts fetches, fetch reuses that response.
  let latest: QuotaResponse = {}
  return {
    id,
    providers: CPA_PROVIDERS,
    async listAccounts() {
      try {
        latest = await api.quota()
      } catch (e) {
        // Config problems (bad key, route missing) are shown as an error, polling goes on normally.
        if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
          return [{ provider: "claude", key: CONFIG_ERROR_KEY, account: "CPA", data: e.message }]
        }
        throw e
      }
      return [...claudeRefs(latest), ...codexRefs(latest)]
    },
    async fetch(refs) {
      const out = new Map<string, FetchResult>()
      const now = clock()
      for (const ref of refs) {
        if (ref.key === CONFIG_ERROR_KEY) {
          out.set(ref.key, { error: String(ref.data) })
        } else if (ref.provider === "claude") {
          const { provider: _p, account: _a, ...q } = mapRouterAccount({ provider: ref.provider, account: ref.account }, ref.data, now)
          out.set(ref.key, q)
        } else if (ref.provider === "codex") {
          out.set(ref.key, codexResult(ref.data as CodexEntry))
        }
      }
      return out
    },
  }
}
