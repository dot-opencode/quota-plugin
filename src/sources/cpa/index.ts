import { fileURLToPath } from "node:url"
import type { AccountRef, FetchResult, ProviderMeta, QuotaSource } from "../../source.ts"
import type { AccountQuota } from "../../types.ts"
import { ApiError, isAuthRejection, type Api, type AuthFile } from "./api.ts"
import {
  AG_HEADERS,
  AG_HOSTS,
  accountName,
  codexAccountId,
  mapRouterAccount,
  parseAntigravity,
  parseCodex,
  parseKimi,
} from "./parsers.ts"

type Fetcher = (api: Api, f: AuthFile) => Promise<Omit<AccountQuota, "provider" | "account">>

const fetchers: Record<string, Fetcher> = {
  async codex(api, f) {
    const header: Record<string, string> = {
      Authorization: "Bearer $TOKEN$",
      "Content-Type": "application/json",
      "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
    }
    const accountId = codexAccountId(f)
    if (accountId) header["Chatgpt-Account-Id"] = accountId
    const body = await api.apiCall({
      authIndex: f.auth_index,
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
      header,
    })
    return parseCodex(body)
  },

  async antigravity(api, f) {
    let lastErr: unknown
    let sawEmpty = false
    let project: string | undefined = f.project_id || f.metadata?.project_id || f.attributes?.project_id
    for (const host of AG_HOSTS) {
      try {
        if (!project) {
          const la = await api.apiCall({
            authIndex: f.auth_index,
            method: "POST",
            url: `https://${host}/v1internal:loadCodeAssist`,
            header: AG_HEADERS,
            data: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
          })
          const p = la?.cloudaicompanionProject
          project = typeof p === "string" ? p : p?.id
        }
        const body = await api.apiCall({
          authIndex: f.auth_index,
          method: "POST",
          url: `https://${host}/v1internal:retrieveUserQuotaSummary`,
          header: AG_HEADERS,
          data: JSON.stringify({ project }),
        })
        const windows = parseAntigravity(body)
        if (windows.length) return { windows }
        sawEmpty = true
      } catch (e) {
        if (isAuthRejection(e)) throw e
        lastErr = e
      }
    }
    if (sawEmpty || !lastErr) return { windows: [] }
    throw lastErr
  },

  async kimi(api, f) {
    const body = await api.apiCall({
      authIndex: f.auth_index,
      method: "GET",
      url: "https://api.kimi.com/coding/v1/usages",
      header: { Authorization: "Bearer $TOKEN$" },
    })
    return { windows: parseKimi(body) }
  },
}

const logo = (id: string) => fileURLToPath(new URL(`../../../assets/${id}.png`, import.meta.url))

export const CPA_PROVIDERS: ProviderMeta[] = [
  { id: "claude", providerIDs: ["claude"], modelPrefixes: ["claude"], backoff: false, logo: logo("claude") },
  { id: "codex", providerIDs: ["codex"], modelPrefixes: ["gpt", "codex"], modelPattern: "^o[134](\\b|-|$)", logo: logo("codex") },
  { id: "antigravity", providerIDs: ["antigravity"], modelPrefixes: ["gemini"], logo: logo("antigravity") },
  { id: "kimi", providerIDs: ["kimi"], modelPrefixes: ["kimi"], logo: logo("kimi") },
]

export function supportedProvider(p: string): boolean {
  return p === "claude" || p in fetchers
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function fetchClaude(api: Api, refs: AccountRef[], now: number): Promise<Map<string, FetchResult>> {
  const out = new Map<string, FetchResult>()
  let status: any
  try {
    status = await api.routerStatus()
  } catch (e) {
    if (isAuthRejection(e)) throw e
    for (const ref of refs) out.set(ref.key, { error: errMsg(e) })
    return out
  }
  const byIndex = new Map<string, any>()
  for (const a of Array.isArray(status?.accounts) ? status.accounts : []) {
    if (a?.auth_index !== undefined && a?.auth_index !== null) byIndex.set(String(a.auth_index), a)
  }
  for (const ref of refs) {
    const a = byIndex.get(ref.key)
    if (!a) {
      out.set(ref.key, { error: "not in router status" })
      continue
    }
    const { provider: _p, account: _a, ...q } = mapRouterAccount({ provider: ref.provider, account: ref.account }, a, now)
    out.set(ref.key, q)
  }
  return out
}

async function fetchOne(api: Api, ref: AccountRef): Promise<FetchResult> {
  try {
    return await fetchers[ref.provider]!(api, ref.data as AuthFile)
  } catch (e) {
    if (isAuthRejection(e)) throw e
    return { error: errMsg(e), retryAfterMs: e instanceof ApiError ? e.retryAfterMs : undefined }
  }
}

export function createCpaSource(api: Api, id = "cpa", clock: () => number = Date.now): QuotaSource {
  return {
    id,
    providers: CPA_PROVIDERS,
    async listAccounts() {
      return (await api.listAuthFiles())
        .filter((f) => supportedProvider(f.provider))
        .map((f) => ({ provider: f.provider, key: f.auth_index, account: accountName(f), data: f }))
    },
    async fetch(refs) {
      const out = new Map<string, FetchResult>()
      const claude = refs.filter((r) => r.provider === "claude")
      const others = refs.filter((r) => r.provider !== "claude")
      const [c, rest] = await Promise.all([
        claude.length ? fetchClaude(api, claude, clock()) : Promise.resolve(new Map<string, FetchResult>()),
        Promise.all(others.map(async (r) => [r.key, await fetchOne(api, r)] as const)),
      ])
      for (const [k, v] of c) out.set(k, v)
      for (const [k, v] of rest) out.set(k, v)
      return out
    },
    fatal(e) {
      return isAuthRejection(e) ? (e.status === 403 ? "access denied (403)" : "invalid key (401)") : undefined
    },
  }
}
