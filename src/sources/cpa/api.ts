export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Retry delay in ms, when known. */
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

export interface CodexEntry {
  auth_index: string
  email?: string
  label?: string
  /** Raw chatgpt.com/backend-api/wham/usage JSON. */
  usage?: unknown
  error?: string
  retry_after_ms?: number
  fetched_at?: string
}

export interface QuotaResponse {
  /** Status of the five-hour-quota-router plugin (`{ accounts: [...] }`). */
  claude?: any
  codex?: CodexEntry[]
}

export interface Api {
  /** One request serving all providers: `GET {url}/v0/resource/plugins/five-hour-quota-router/quota`. */
  quota(): Promise<QuotaResponse>
}

export function createApi(config: { url: string; key: string }, fetchImpl: typeof fetch = fetch): Api {
  return {
    async quota() {
      const res = await fetchImpl(`${config.url}/v0/resource/plugins/five-hour-quota-router/quota`, {
        headers: { Authorization: `Bearer ${config.key}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 401) throw new ApiError("CPA quota key rejected (401)", 401)
      if (res.status === 404)
        throw new ApiError(
          "quota route not found (404): update the five-hour-quota-router plugin and configure plugins.configs.five-hour-quota-router.quota-api-keys",
          404,
        )
      if (!res.ok) throw new ApiError(`quota HTTP ${res.status}`, res.status)
      const json: any = await res.json()
      return json && typeof json === "object" ? json : {}
    },
  }
}
