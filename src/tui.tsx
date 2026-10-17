import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Index, onMount, Show, type JSX } from "solid-js"
import { fileURLToPath } from "node:url"
import { TextAttributes } from "@opentui/core"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { QuotaRpc } from "./rpc.ts"
import { fromWire, type Snapshot, type WireSnapshot } from "./snapshot.ts"
import {
  barFill,
  compactSegments,
  providerForModel,
  reportGroups,
  type ReportAccount,
  type ReportGroup,
  type Segment,
  type Tone,
} from "./format.ts"

const logoPath = (id: string) => fileURLToPath(new URL(`../assets/${id}.png`, import.meta.url))
// Providers whose logo failed to load fall back to the text name.
const [brokenLogos, setBrokenLogos] = createSignal<Record<string, boolean>>({})

/** Maps a semantic tone to a theme token. Read inside JSX so it follows theme switches. */
const toneColor = (theme: ResolvedTheme, tone: Tone) => {
  const t = theme.text
  switch (tone) {
    case "provider": return t.base
    case "ok": return t.feedback.success.base
    case "warn": return t.feedback.warning.base
    case "critical": return t.feedback.error.base
    case "empty": return t.feedback.error.muted
    case "label":
    case "stale": return t.muted
  }
}

/** Provider logo (2x1 cells); falls back to the provider name if the image fails to load. */
function Logo(props: { id: string; fallback: JSX.Element }) {
  return (
    <Show when={!brokenLogos()[props.id]} fallback={props.fallback}>
      <image
        source={logoPath(props.id)}
        width={2}
        height={1}
        fit="fit"
        onError={() => setBrokenLogos((b) => ({ ...b, [props.id]: true }))}
      />
      <text> </text>
    </Show>
  )
}

const BAR_WIDTH = 10

/** Body of the /quota dialog: one block per provider, logo + account header, then window rows. */
function QuotaReport(props: { theme: () => ResolvedTheme; groups: () => ReportGroup[] }) {
  const th = () => props.theme()
  // Index (not For): updates arrive as new objects every refresh; keying by position
  // updates rows in place instead of recreating them (and reloading logo images).
  const accountBlock = (provider: () => string, a: () => ReportAccount, first: boolean) => {
    // Per-account label column, so one provider's long labels don't widen the others.
    const labelWidth = () => Math.max(2, ...a().windows.map((w) => w.label.length)) + 2
    return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" height={1} flexShrink={0}>
        <Show when={first} fallback={<text>{"   "}</text>}>
          <Show when={provider()} keyed>
            {(id) => <Logo id={id} fallback={<text fg={th().text.base}>{`${id} `}</text>} />}
          </Show>
        </Show>
        <text fg={th().text.base} attributes={TextAttributes.BOLD} wrapMode="none">{a().account}</text>
        <Show when={a().plan}>
          <text fg={th().text.muted} wrapMode="none">{` · ${a().plan}`}</text>
        </Show>
      </box>
      <Show when={a().error}>
        <text fg={th().text.feedback.error.base} paddingLeft={3}>{`error: ${a().error}`}</text>
      </Show>
      <Show when={!a().error && !a().windows.length}>
        <text fg={th().text.muted} paddingLeft={3}>no quota data</text>
      </Show>
      <Index each={a().windows}>
        {(w) => {
          const fill = () => barFill(w().remainingPct, BAR_WIDTH)
          return (
            <box flexDirection="row" height={1} flexShrink={0} paddingLeft={3}>
              <text fg={th().text.muted} wrapMode="none">{w().label.padEnd(labelWidth())}</text>
              <text fg={toneColor(th(), w().tone)} wrapMode="none">{"━".repeat(fill())}</text>
              <text fg={th().border.base} wrapMode="none">{"━".repeat(BAR_WIDTH - fill())}</text>
              <text fg={toneColor(th(), w().tone)} wrapMode="none">{w().pct.padStart(5)}</text>
              <Show when={w().detail}>
                <text fg={th().text.base} wrapMode="none">{`  ${w().detail}`}</text>
              </Show>
              <Show when={w().reset}>
                <text fg={th().text.muted} wrapMode="none">{`  resets in ${w().reset}`}</text>
              </Show>
            </box>
          )
        }}
      </Index>
      <Show when={a().stale}>
        <text fg={th().text.muted} paddingLeft={3}>{a().stale}</text>
      </Show>
    </box>
    )
  }

  return (
    <Show when={props.groups().length} fallback={<text fg={th().text.muted}>No accounts found.</text>}>
      <box flexDirection="column" gap={1}>
        <Index each={props.groups()}>
          {(g) => (
            <box flexDirection="column" flexShrink={0}>
              <Index each={g().accounts}>{(a, i) => accountBlock(() => g().provider, a, i === 0)}</Index>
            </box>
          )}
        </Index>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "cpa-quota",
  setup(context) {
    const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>(undefined)
    // True when the server plugin could not be reached (not loaded, or RPC failure).
    const [unavailable, setUnavailable] = createSignal(false)
    const accounts = () => snapshot()?.accounts
    const rejected = () => snapshot()?.rejected

    // Fetching and polling live in the server plugin; this side only displays what it sends.
    const api = context.client.rpc(QuotaRpc)
    const apply = (wire: WireSnapshot) => {
      setSnapshot(fromWire(wire))
      setUnavailable(false)
    }
    api.get({}).then(apply, () => setUnavailable(true))
    const unsubscribe = api.events.on("changed", (event) => apply(event.data as WireSnapshot))

    const currentProvider = (sessionID?: string): string | undefined => {
      try {
        // Prompt's selected model (reactive, updates before the next message is sent).
        const selected = context.ui.model?.current?.()
        if (selected) return providerForModel(selected.modelID, selected.providerID)
        const model = sessionID ? context.data.session.get(sessionID)?.model : undefined
        return providerForModel(model?.id, model?.providerID)
      } catch {
        return undefined
      }
    }

    const disposeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const segments = (): Segment[] => {
          if (unavailable() && !snapshot()) return [{ text: "quota: n/a", tone: "stale" }]
          const snap = snapshot()
          if (snap && !snap.configured) return [{ text: "quota: set CPA_MANAGEMENT_URL and CPA_MANAGEMENT_KEY", tone: "warn" }]
          const why = rejected()
          if (why) return [{ text: `quota: ${why}, paused — /quota to retry`, tone: "critical" }]
          const data = accounts()
          if (!data) return [{ text: "quota …", tone: "stale" }]
          const list = compactSegments(data, currentProvider(input.sessionID))
          return list.length ? list : [{ text: snap?.failed ? "quota: n/a" : "", tone: "stale" }]
        }
        // context.theme is reactive: colors follow theme and light/dark switches.
        const textOf = (s: () => Segment) => <text style={{ fg: toneColor(context.theme, s().tone) }}>{s().text}</text>
        // Index (not For): each refresh yields new segment objects; keying by position updates
        // text in place, and a logo is recreated only when the provider at that position changes.
        return (
          <box flexDirection="row" height={1} flexShrink={0} onMouseUp={() => context.keymap.dispatch("cpa-quota.show")}>
            <Index each={segments()}>
              {(s) => (
                <Show when={s().provider} keyed fallback={textOf(s)}>
                  {(id) => <Logo id={id} fallback={textOf(s)} />}
                </Show>
              )}
            </Index>
          </box>
        )
      },
    })

    // Mirrors the built-in alert: dialog surface colors, padding 2, bold title with "esc" hint,
    // "ok" button. The dialog host closes on Esc itself; Enter is bound here like in alert.
    // Opens immediately; shows cached data (or "Loading…") while a forced refresh runs.
    const MSG_UNAVAILABLE = "Failed to fetch quotas."
    const MSG_NO_KEY = "Set CPA_MANAGEMENT_URL (or the url option) and CPA_MANAGEMENT_KEY in the environment."
    const msgRejected = (why: string) =>
      `Management API: ${why}. Check CPA_MANAGEMENT_KEY; after 5 failed attempts the proxy bans the IP for 30 minutes. Auto-refresh is paused.`
    const showQuotaDialog = () => {
      const close = () => context.ui.dialog.clear()
      const [loading, setLoading] = createSignal(true)
      const [failedCall, setFailedCall] = createSignal(false)
      api.get({ force: true }).then(
        (wire) => {
          apply(wire)
          setLoading(false)
        },
        () => {
          setFailedCall(true)
          setLoading(false)
        },
      )
      context.ui.dialog.show(() => {
        const theme = () => context.theme.surface("dialog")
        // Follows background refreshes while open.
        const groups = () => reportGroups(accounts() ?? [])
        // Message shown instead of the report (no data to show).
        const message = (): string | undefined => {
          if (accounts()) return undefined
          if (loading()) return "Loading…"
          const snap = snapshot()
          if (failedCall() || !snap) return MSG_UNAVAILABLE
          if (!snap.configured) return MSG_NO_KEY
          if (snap.rejected) return msgRejected(snap.rejected)
          return "Failed to fetch quotas from the management API."
        }
        context.keymap.layer(() => ({
          mode: "modal",
          commands: [{ bind: "return", title: "Close quotas", group: "Dialog", run: close }],
        }))
        // Long labels (e.g. antigravity model names) need more than the medium width.
        const longest = () =>
          Math.max(0, ...groups().flatMap((g) => g.accounts.flatMap((a) => a.windows.map((w) => w.label.length))))
        // Built-in dialogs set their size on mount too (show() resets it to medium); grow once data arrives.
        onMount(() => createEffect(() => context.ui.dialog.set({ size: longest() > 12 ? "large" : "medium" })))
        return (
          <box paddingLeft={2} paddingRight={2} gap={1}>
            <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
              <box flexDirection="row" flexShrink={0}>
                <text fg={theme().text.base} attributes={TextAttributes.BOLD}>Subscription quotas</text>
                <Show when={accounts() && (loading() || failedCall())}>
                  <text fg={theme().text.muted}>{loading() ? "  updating…" : "  update failed"}</text>
                </Show>
              </box>
              <text fg={theme().text.muted} onMouseUp={close}>esc</text>
            </box>
            <box paddingBottom={1} flexShrink={0}>
              <Show when={message()} fallback={<QuotaReport theme={theme} groups={groups} />}>
                {(m) => <text fg={loading() ? theme().text.muted : theme().text.base}>{m()}</text>}
              </Show>
            </box>
            <box flexDirection="row" justifyContent="flex-end" paddingBottom={1} flexShrink={0}>
              <box
                paddingLeft={3}
                paddingRight={3}
                backgroundColor={theme().background.action.primary.focused}
                onMouseUp={close}
              >
                <text fg={theme().text.action.primary.focused}>ok</text>
              </box>
            </box>
          </box>
        )
      })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "cpa-quota.show",
          title: "Show subscription quotas",
          group: "Quota",
          palette: true,
          slash: { name: "quota" },
          run: () => showQuotaDialog(),
        },
      ],
    }))

    return () => {
      unsubscribe()
      disposeSlot()
    }
  },
})
