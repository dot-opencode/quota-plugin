export interface AuthFile {
  id?: string
  name?: string
  provider: string
  auth_index: string
  email?: string
  label?: string
  project_id?: string
  id_token?: unknown
  metadata?: Record<string, any>
  attributes?: Record<string, any>
  raw: Record<string, any>
}

export function normalizeProvider(raw: unknown): string {
  const p = String(raw ?? "").trim().toLowerCase().replace(/_/g, "-")
  if (p === "anthropic") return "claude"
  if (p === "anti-gravity") return "antigravity"
  if (p === "x-ai" || p === "grok") return "xai"
  return p
}

export function parseAuthFiles(json: any): AuthFile[] {
  const files: any[] = Array.isArray(json?.files) ? json.files : []
  const out: AuthFile[] = []
  for (const f of files) {
    if (!f || typeof f !== "object") continue
    const idx = f.auth_index ?? f.authIndex
    if (idx === undefined || idx === null || String(idx) === "") continue
    if (f.disabled === true) continue
    out.push({
      id: f.id,
      name: f.name,
      provider: normalizeProvider(f.provider ?? f.type ?? f.account_type),
      auth_index: String(idx),
      email: f.email,
      label: f.label,
      project_id: f.project_id,
      id_token: f.id_token,
      metadata: f.metadata,
      attributes: f.attributes,
      raw: f,
    })
  }
  return out
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True when the management API itself rejected the request (not the upstream provider). */
    readonly management = false,
    /** Upstream `Retry-After`, in ms, when the response carried one. */
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

/** Parses a `Retry-After` value (seconds or HTTP-date) from a header map with any key case; string or string[] values. */
export function parseRetryAfter(headers: unknown, now = Date.now()): number | undefined {
  if (!headers || typeof headers !== "object") return undefined
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== "retry-after") continue
    const raw = String(Array.isArray(v) ? v[0] : v ?? "").trim()
    if (!raw) return undefined
    if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000)
    const t = Date.parse(raw)
    return Number.isNaN(t) ? undefined : Math.max(0, t - now)
  }
  return undefined
}

/** Management API refused our credentials or banned the IP — retrying only makes it worse. */
export function isAuthRejection(e: unknown): e is ApiError {
  return e instanceof ApiError && e.management && (e.status === 401 || e.status === 403)
}

export interface ApiCallInput {
  authIndex: string
  method: string
  url: string
  header?: Record<string, string>
  data?: string
}

export interface Api {
  listAuthFiles(): Promise<AuthFile[]>
  apiCall(input: ApiCallInput): Promise<any>
  /** Status of the five-hour-quota-router CPA plugin (source of all Claude quota values). */
  routerStatus(): Promise<any>
}

export function createApi(config: { url: string; key: string }, fetchImpl: typeof fetch = fetch): Api {
  const base = `${config.url}/v0/management`
  const headers = () => ({ Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" })

  return {
    async listAuthFiles() {
      const res = await fetchImpl(`${base}/auth-files`, { headers: headers(), signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new ApiError(`auth-files HTTP ${res.status}`, res.status, true)
      return parseAuthFiles(await res.json())
    },
    async routerStatus() {
      const res = await fetchImpl(`${base}/plugins/five-hour-quota-router/status`, {
        headers: headers(),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new ApiError(`router status HTTP ${res.status}`, res.status, true)
      return res.json()
    },
    async apiCall(input) {
      const res = await fetchImpl(`${base}/api-call`, {
        method: "POST",
        headers: headers(),
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          auth_index: input.authIndex,
          authIndex: input.authIndex,
          method: input.method,
          url: input.url,
          header: input.header ?? {},
          data: input.data,
          body: input.data,
        }),
      })
      if (!res.ok) throw new ApiError(`api-call HTTP ${res.status}`, res.status, true)
      const wrapped: any = await res.json()
      const status = Number(wrapped?.status_code ?? wrapped?.statusCode ?? 0)
      if (status < 200 || status >= 300) {
        const retryAfter = parseRetryAfter(wrapped?.header ?? wrapped?.headers)
        throw new ApiError(`upstream HTTP ${status}`, status, false, retryAfter)
      }
      const body = wrapped?.body
      if (typeof body !== "string") return body ?? null
      try {
        return JSON.parse(body)
      } catch {
        throw new ApiError("upstream returned non-JSON body", status)
      }
    },
  }
}
