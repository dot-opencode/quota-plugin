export interface Config {
  url: string | undefined
  key: string | undefined
  refreshSec: number
}

export function loadConfig(
  options: Readonly<Record<string, any>> = {},
  env: Record<string, string | undefined> = process.env,
): Config {
  const rawUrl = (typeof options.url === "string" && options.url) || env.CPA_MANAGEMENT_URL || ""
  const refresh = Number(options.refreshSec)
  return {
    url: rawUrl.replace(/\/+$/, "") || undefined,
    key: env.CPA_MANAGEMENT_KEY || undefined,
    refreshSec: Number.isFinite(refresh) && refresh >= 30 ? refresh : 300,
  }
}
