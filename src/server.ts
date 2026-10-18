import { Plugin } from "@opencode/plugin"
import { fetchAllQuotas } from "./base.ts"
import { registerQuotaSource } from "./source.ts"
import { createApi } from "./sources/cpa/api.ts"
import { loadConfig, type Config } from "./sources/cpa/config.ts"
import { createCpaSource } from "./sources/cpa/index.ts"
import { QuotaRpc } from "./rpc.ts"
import { toWire } from "./snapshot.ts"
import { getStore, type Listener, type Poller } from "./store.ts"

/**
 * The server plugin is set up once per project (location) in the same process, so
 * polling lives in a process-wide store (globalThis, see store.ts; the server loads
 * this module many times): one timer and one snapshot shared by all instances. Each instance only registers its RPC and forwards `changed` events.
 * Quota sources (built-in CPA, or registered by other plugins) live in store.registry.
 */
const store = getStore()

const hasSources = () => store.registry.sources.size > 0

function stopPolling(p: Poller) {
  if (p.timer) clearInterval(p.timer)
  p.timer = undefined
}

function startPolling(p: Poller) {
  stopPolling(p)
  p.timer = setInterval(() => void refresh(p), p.refreshSec * 1000)
}

// A source rejected by `fatal` (e.g. 401/403) is skipped until a forced get succeeds,
// so a bad key can't trip the proxy's 5-failures-per-IP ban.
async function run(p: Poller, force: boolean) {
  const configured = hasSources()
  try {
    const r = await fetchAllQuotas(force)
    p.snapshot = { configured, accounts: r.accounts, failed: r.failed, rejected: r.rejected, providers: r.providers }
  } catch (e) {
    p.snapshot = { ...p.snapshot, configured, failed: true }
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

/** Registry changed: refresh right away; the timer runs only while there are listeners and sources. */
function onRegistryChange(p: Poller) {
  if (!p.listeners.size) return
  if (hasSources()) {
    void refresh(p, true)
    if (!p.timer) startPolling(p)
  } else {
    stopPolling(p)
    void refresh(p, true)
  }
}

/** Both the management URL and key are required; without either no CPA source is registered. */
function registerCpa(config: Config): (() => void) | undefined {
  return config.url && config.key ? registerQuotaSource(createCpaSource(createApi({ url: config.url, key: config.key }))) : undefined
}

const configKey = (c: Config) => JSON.stringify([c.url, c.key, c.refreshSec])

function acquire(options: Readonly<Record<string, any>>): Poller {
  const config = loadConfig(options)
  const key = configKey(config)
  const existing = store.poller
  if (existing) {
    if (existing.configKey === key) return existing
    // Different config: drop the old timer and CPA source, rebuild in place so every holder sees the new state.
    stopPolling(existing)
    existing.unregisterCpa?.()
    existing.configKey = key
    existing.refreshSec = config.refreshSec
    existing.unregisterCpa = registerCpa(config)
    existing.snapshot = { configured: hasSources(), failed: false }
    return existing
  }
  const p: Poller = {
    configKey: key,
    refreshSec: config.refreshSec,
    snapshot: { configured: false, failed: false },
    listeners: new Set(),
  }
  p.unregisterCpa = registerCpa(config)
  p.snapshot = { configured: hasSources(), failed: false }
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
        else if (!p.snapshot.accounts && !p.snapshot.failed && hasSources()) await refresh(p)
        else if (p.snapshot.configured !== hasSources()) await refresh(p)
        return toWire(p.snapshot)
      },
    })
    const listener: Listener = (s) => reg.events.emit("changed", toWire(s))
    p.listeners.add(listener)

    // First instance starts polling and watches the registry; later ones reuse it.
    if (!p.offRegistry) {
      const onChange = () => onRegistryChange(p)
      store.registry.listeners.add(onChange)
      p.offRegistry = () => store.registry.listeners.delete(onChange)
    }
    if (hasSources() && !p.timer) {
      void refresh(p)
      startPolling(p)
    }

    return () => {
      p.listeners.delete(listener)
      reg.dispose()
      if (!p.listeners.size) {
        stopPolling(p)
        p.offRegistry?.()
        p.offRegistry = undefined
        p.unregisterCpa?.()
        p.unregisterCpa = undefined
        if (store.poller === p) store.poller = undefined
      }
    }
  },
})
