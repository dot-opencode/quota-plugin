import { Command, ComposerPill, createKeyed, Plugin, type ComposerPillRow, type ComposerPillTone, type IconName } from "@opencode/plugin/gui"
import { createSignal, onCleanup } from "solid-js"
import { compactSegments, providerForModel, reportGroups, type Tone } from "./format.ts"
import claude from "./gui/icons/claude.svg?raw"
import codex from "./gui/icons/codex.svg?raw"
import { QuotaRpc } from "./rpc.ts"
import { fromWire, type Snapshot } from "./snapshot.ts"

const FALLBACK_INTERVAL_MS = 5 * 60 * 1000

// Provider marks from @lobehub/icons (MIT), adapted to currentColor.
const providerIcons = { claude, codex }

function pillTone(tone: Tone): ComposerPillTone | undefined {
  switch (tone) {
    case "ok": return "success"
    case "warn": return "warning"
    case "critical":
    case "empty": return "danger"
  }
}

export default Plugin.define({
  // The live docs support plugin icons, but the 2.3.2 SDK does not declare them yet.
  ...{ icons: providerIcons },
  i18n: {
    en: {
      title: "Subscription quotas",
      refresh: "Refresh",
      "refresh.command": "Refresh subscription quotas",
      "refresh.failed": "Failed to refresh subscription quotas",
      "status.unavailable": "quota: n/a",
      "status.unconfigured": "quota: set CPA_URL and CPA_QUOTA_KEY",
      "status.rejected": "quota: {{reason}}, paused — /quota to retry",
      "status.loading": "quota …",
      "row.reset": "resets in {{time}}",
      "row.error": "error: {{reason}}",
      "row.empty": "no quota data",
    },
  },
  setup(ctx) {
    const [snapshot, setSnapshot] = createSignal<Snapshot>()
    const [unavailable, setUnavailable] = createSignal(false)

    async function refresh(force = false) {
      const client = ctx.client
      const active = () => !ctx.signal.aborted && client === ctx.client
      try {
        const wire = await client.rpc(QuotaRpc).get(force ? { force: true } : {}, { signal: ctx.signal })
        if (!active()) return
        const next = fromWire(wire)
        setSnapshot(next)
        setUnavailable(false)
        if (force && (next.failed || next.rejected)) {
          ctx.toast.show({ variant: "error", title: ctx.t("refresh.failed"), description: next.rejected })
        }
      } catch {
        if (!active()) return
        setUnavailable(true)
        if (force) ctx.toast.show({ variant: "error", title: ctx.t("refresh.failed") })
      }
    }

    createKeyed(() => ctx.client, (client) => {
      const unsubscribe = client.rpc(QuotaRpc).events.on("changed", (event) => {
        if (ctx.signal.aborted || client !== ctx.client) return
        setSnapshot(fromWire(event.data))
        setUnavailable(false)
      })
      onCleanup(unsubscribe)
      void refresh()
    })
    const timer = setInterval(() => void refresh(), FALLBACK_INTERVAL_MS)

    const iconFor = (provider?: string): IconName => {
      const icons = (ctx as typeof ctx & { icons?: Record<keyof typeof providerIcons, IconName> }).icons
      if (provider === "claude" || provider === "codex") return icons?.[provider] ?? "status"
      return "status"
    }

    ctx.add(ComposerPill, {
      id: "quota",
      show(input) {
        const snap = snapshot()
        const metas = snap?.providers ?? []
        const accounts = snap?.accounts ?? []
        const model = input.screen.composer.model()
        const provider = providerForModel(metas, model?.modelID, model?.providerID)
        const now = Date.now()
        const segments = compactSegments(metas, provider ? accounts.filter((a) => a.provider === provider) : accounts, provider, now)
        const title = ctx.t("title")
        const rows: ComposerPillRow[] = [{ id: "refresh", label: ctx.t("refresh"), run: () => void refresh(true) }]

        if (snap && !snap.configured) return { title, rows, label: ctx.t("status.unconfigured"), icon: "status", tone: "warning" }
        if (snap?.rejected) return { title, rows, label: ctx.t("status.rejected", { reason: snap.rejected }), icon: "status", tone: "danger" }
        if (!segments.length && (snap?.failed || (unavailable() && !snap))) return { title, rows, label: ctx.t("status.unavailable") }
        if (!snap?.accounts) return { title, rows, label: ctx.t("status.loading") }
        if (!segments.length) return undefined

        const detailRows = reportGroups(metas, accounts, now).flatMap((group) => {
          const name = metas.find((m) => m.id === group.provider)?.name ?? group.provider
          const icon = iconFor(group.provider)
          return group.accounts.flatMap((account, i): ComposerPillRow[] => {
            const id = `${group.provider}:${i}`
            const label = [name, account.account, account.plan].filter(Boolean).join(" · ")
            if (account.error || !account.windows.length) {
              return [{
                id,
                label,
                icon,
                tone: account.error ? "danger" : undefined,
                detail: account.error ? ctx.t("row.error", { reason: account.error }) : ctx.t("row.empty"),
              }]
            }
            return account.windows.map((window, j) => ({
              id: `${id}:${j}`,
              label: `${label} · ${window.label}`,
              icon,
              tone: pillTone(window.tone),
              detail: [window.pct, window.detail, window.reset && ctx.t("row.reset", { time: window.reset }), account.stale]
                .filter(Boolean).join(" · "),
            }))
          })
        })

        const tones = segments.map((segment) => pillTone(segment.tone))
        const tone = tones.includes("danger") ? "danger" : tones.includes("warning") ? "warning" : tones.includes("success") ? "success" : undefined
        const displayedProviders = segments.flatMap((segment) => segment.provider ? [segment.provider] : [])
        return {
          title,
          label: segments.map((segment) => segment.text).join(""),
          icon: iconFor(displayedProviders.length === 1 ? displayedProviders[0] : undefined),
          tone,
          rows: [...detailRows, ...rows],
        }
      },
    })

    ctx.add(Command, (): Command => ({
      id: "refresh",
      title: ctx.t("refresh.command"),
      slash: { name: "quota" },
      run: () => refresh(true),
    }))

    return () => clearInterval(timer)
  },
})
