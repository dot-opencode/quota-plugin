import { Plugin } from "@opencode/plugin"
import { createApi, isAuthRejection, type Api } from "./api.ts"
import { loadConfig, type Config } from "./config.ts"
import { fetchAllQuotas } from "./providers.ts"
import { QuotaRpc } from "./rpc.ts"
import { toWire } from "./snapshot.ts"
import { getStore, type Listener, type Poller } from "./store.ts"

/**
 * The server plugin is set up once per project (location) in the same process, so
 * polling lives in a process-wide store (globalThis, see store.ts; the server loads
 * this module many times): one timer and one snapshot shared by all instances. Each instance only registers its RPC and forwards `changed` events.
 */
const store = getStore()

function stopPolling(p: Poller) {
  if (p.timer) clearInterval(p.timer)
  p.timer = undefined
}

// Stops on auth rejection (401/403) so a bad key can't trip the proxy's
// 5-failures-per-IP ban; a forced get retries once and restarts polling on success.
function startPolling(p: Poller) {
  stopPolling(p)
  p.timer = setInterval(() => void refresh(p), p.config.refreshSec * 1000)
}

async function run(p: Poller, force: boolean) {
  if (!p.api) return
  try {
    const accounts = await fetchAllQuotas(p.api, p.config.url ?? "", force)
    const wasRejected = p.snapshot.rejected !== undefined
    p.snapshot = { configured: true, accounts, failed: false }
    if (wasRejected && p.listeners.size) startPolling(p)
  } catch (e) {
    let rejected = p.snapshot.rejected
    if (isAuthRejection(e)) {
      stopPolling(p)
      rejected = e.status === 403 ? "access denied (403)" : "invalid key (401)"
    }
    p.snapshot = { ...p.snapshot, configured: true, failed: true, rejected }
  }
  await Promise.all([...p.listeners].map((l) => l(p.snapshot).catch(() => {})))
}

function refresh(p: Poller, force = false): Promise<void> {
  if (p.inflight && !force) return p.inflight
  const r = run(p, force).finally(() => {
    if (p.inflight === r) p.inflight = undefined
  })
  p.inflight = r
  return r
}

/** Both the management URL and key are required; without either the footer asks for them. */
function makeApi(config: Config): Api | undefined {
  return config.url && config.key ? createApi({ url: config.url, key: config.key }) : undefined
}

function acquire(options: Readonly<Record<string, any>>): Poller {
  const config = loadConfig(options)
  const existing = store.poller
  if (existing) {
    const c = existing.config
    if (c.url === config.url && c.key === config.key && c.refreshSec === config.refreshSec) return existing
    // Different config: drop the old timer and rebuild in place so every holder sees the new state.
    stopPolling(existing)
    existing.config = config
    existing.api = makeApi(config)
    existing.snapshot = { configured: !!existing.api, failed: false }
    return existing
  }
  const api = makeApi(config)
  const p: Poller = { config, api, snapshot: { configured: !!api, failed: false }, listeners: new Set() }
  store.poller = p
  return p
}

export default Plugin.define({
  id: "cpa-quota",
  setup: async (context) => {
    const p = acquire(context.options)

    const reg = await context.rpc.register(QuotaRpc, {
      get: async (input) => {
        if (input.force) await refresh(p, true)
        else if (!p.snapshot.accounts && !p.snapshot.failed && p.api) await refresh(p)
        return toWire(p.snapshot)
      },
    })
    const listener: Listener = (s) => reg.events.emit("changed", toWire(s))
    p.listeners.add(listener)

    // First instance starts polling; later ones reuse it.
    if (p.api && !p.timer && !p.snapshot.rejected) {
      void refresh(p)
      startPolling(p)
    }

    return () => {
      p.listeners.delete(listener)
      reg.dispose()
      if (!p.listeners.size) {
        stopPolling(p)
        if (store.poller === p) store.poller = undefined
      }
    }
  },
})
