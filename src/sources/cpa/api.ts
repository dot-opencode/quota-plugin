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

export interface QuotaEntry {
  auth_index: string
  email?: string
  label?: string
  /** Raw provider usage JSON. */
  usage?: unknown
  error?: string
  retry_after_ms?: number
  fetched_at?: string
}

export interface QuotaResponse {
  claude?: QuotaEntry[]
  codex?: QuotaEntry[]
}

export interface Api {
  /** One request serving all providers: `GET {url}/v0/resource/plugins/quota-api/quota`. */
  quota(): Promise<QuotaResponse>
}

export function createApi(config: { url: string; key: string }, fetchImpl: typeof fetch = fetch): Api {
  return {
    async quota() {
      const res = await fetchImpl(`${config.url}/v0/resource/plugins/quota-api/quota`, {
        headers: { Authorization: `Bearer ${config.key}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 401) throw new ApiError("CPA quota key rejected (401)", 401)
      if (res.status === 404)
        throw new ApiError(
          "quota route not found (404): enable the quota-api plugin and configure plugins.configs.quota-api.quota-api-keys",
          404,
        )
      if (!res.ok) throw new ApiError(`quota HTTP ${res.status}`, res.status)
      const json: any = await res.json()
      return json && typeof json === "object" && !Array.isArray(json) ? json : {}
    },
  }
}
