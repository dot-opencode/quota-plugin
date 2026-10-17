// ==UserScript==
// @name         OpenCode CPA quota
// @namespace    opencode-cpa-quota
// @version      0.2.0
// @description  Shows subscription quotas (Claude, Codex, Antigravity, Kimi) under the OpenCode V2 web composer. Requires the opencode-cpa-quota server plugin.
// @match        http://127.0.0.1/*
// @match        http://localhost/*
// @grant        none
// @sandbox      raw
// @inject-into  page
// @run-at       document-start
// ==/UserScript==

;(function () {
  "use strict"

  // ---------------------------------------------------------------------------
  // Formatting (port of src/format.ts)
  // ---------------------------------------------------------------------------

  const PROVIDERS = ["claude", "codex", "antigravity", "kimi"]
  const LOGOS = logoData() // provider id → data: URL (generated block at the end of the file)
  const WARN_BELOW = 20
  const CRITICAL_BELOW = 5

  /** Maps the composer's model button text ("Claude Opus", "GPT-5") to a provider id. */
  function providerForModel(text) {
    const m = (text || "").trim().toLowerCase().split("/").pop().replace(/\s+/g, "-")
    if (PROVIDERS.includes(m)) return m
    if (m.startsWith("claude")) return "claude"
    if (m.startsWith("gpt") || m.startsWith("codex") || /^o[134](\b|-|$)/.test(m)) return "codex"
    if (m.startsWith("gemini")) return "antigravity"
    if (m.startsWith("kimi")) return "kimi"
    return undefined
  }

  function formatReset(resetsAt, now) {
    const mins = Math.max(0, Math.round((resetsAt - now) / 60000))
    const d = Math.floor(mins / 1440)
    const h = Math.floor((mins % 1440) / 60)
    const m = mins % 60
    if (d > 0) return `${d}d ${h}h`
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
  }

  const ago = (since, now) => (now - since < 60000 ? "just now" : `${formatReset(now, since)} ago`)
  const pct = (n) => `${Math.round(n)}%`

  function toneFor(remainingPct) {
    if (remainingPct <= 0) return "empty"
    if (remainingPct < CRITICAL_BELOW) return "critical"
    if (remainingPct < WARN_BELOW) return "warn"
    return "ok"
  }

  /** Main windows: 5h and 7d if present, else first two. */
  function mainWindows(ws) {
    const main = ws.filter((w) => w.label === "5h" || w.label === "7d")
    return main.length ? main : ws.slice(0, 2)
  }

  const seg = (text, tone) => ({ text, tone })

  function accountSegments(a, now) {
    if (!a || a.error || !a.windows.length) return [seg("n/a", "stale")]
    const out = []
    mainWindows(a.windows).forEach((w, i) => {
      if (i > 0) out.push(seg(" · ", "label"))
      out.push(seg(`${w.label} `, "label"), seg(pct(w.remainingPct), toneFor(w.remainingPct)))
      if (w.label === "5h" && w.resetsAt && w.remainingPct < 99.5) out.push(seg(` (${formatReset(w.resetsAt, now)})`, "label"))
    })
    return out
  }

  const minRemaining = (a) =>
    a.windows.length ? Math.min(...mainWindows(a.windows).map((w) => w.remainingPct)) : Infinity

  /** Active provider first with every account; others show only their most-depleted account. */
  function compactSegments(accounts, active, now) {
    const providers = active ? [active, ...PROVIDERS.filter((p) => p !== active)] : PROVIDERS
    const out = []
    for (const p of providers) {
      const accts = accounts.filter((a) => a.provider === p)
      if (!accts.length) continue
      if (out.length) out.push(seg("  ", "label"))
      out.push({ text: `${p} `, tone: "provider", provider: p })
      if (p === active && accts.length > 1) {
        accts.forEach((a, i) => {
          if (i > 0) out.push(seg(" / ", "label"))
          out.push(...accountSegments(a, now))
        })
      } else {
        const ok = accts.filter((a) => !a.error && a.windows.length)
        out.push(...accountSegments(ok.sort((a, b) => minRemaining(a) - minRemaining(b))[0], now))
      }
    }
    return out
  }

  function reportGroups(accounts, now) {
    const order = new Set([...PROVIDERS, ...accounts.map((a) => a.provider)])
    const groups = []
    for (const provider of order) {
      const accts = accounts.filter((a) => a.provider === provider)
      if (!accts.length) continue
      groups.push({
        provider,
        accounts: accts.map((a) => ({
          account: a.account,
          plan: a.plan,
          error: a.error,
          windows: a.error
            ? []
            : a.windows.map((w) => ({
                label: w.label,
                pct: pct(w.remainingPct),
                remainingPct: w.remainingPct,
                tone: toneFor(w.remainingPct),
                reset: w.resetsAt && w.remainingPct < 99.5 ? formatReset(w.resetsAt, now) : undefined,
                detail: w.detail,
              })),
          stale: a.staleSince && !a.error ? `updated ${ago(a.staleSince, now)}` : undefined,
        })),
      })
    }
    return groups
  }

  // ---------------------------------------------------------------------------
  // State and data (server plugin RPC + event stream)
  // ---------------------------------------------------------------------------

  let ready = false // DOM set up (start() ran)

  const state = {
    snapshot: undefined, // last Snapshot from the server plugin
    unavailable: false, // server plugin unreachable
    loading: false, // forced refresh in flight (popover)
    failedCall: false, // last forced refresh failed
    open: false,
  }

  // The web UI may authenticate with `Authorization: Basic …` instead of a session cookie.
  // Wrap fetch before the app loads (document-start, page context) and reuse its header.
  const pageFetch = window.fetch.bind(window)
  let authHeader
  window.fetch = function (input, init) {
    try {
      const h = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined))
      const a = h.get("authorization")
      if (a && a !== authHeader) {
        authHeader = a
        if (ready) {
          refresh(false)
          connectEvents()
        }
      }
    } catch {}
    return pageFetch.apply(this, arguments)
  }
  const authHeaders = (extra) => Object.assign(authHeader ? { authorization: authHeader } : {}, extra)

  async function rpcGet(force) {
    const res = await pageFetch("/api/rpc/cpa-quota/get", {
      method: "POST",
      credentials: "include",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ input: force ? { force: true } : {} }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    if (!body || typeof body.output !== "object" || body.output === null) throw new Error("bad response")
    return body.output
  }

  function apply(wire) {
    state.snapshot = wire
    state.unavailable = false
    render()
  }

  function refresh(force) {
    if (force) {
      state.loading = true
      state.failedCall = false
      render()
    }
    return rpcGet(force).then(
      (wire) => {
        state.loading = false
        apply(wire)
      },
      () => {
        state.loading = false
        if (force) state.failedCall = true
        state.unavailable = true
        render()
      },
    )
  }

  // SSE over fetch: EventSource can't send the Authorization header.
  let retryMs = 1000
  let events // AbortController of the current stream
  let retryTimer
  function connectEvents() {
    if (events) events.abort()
    clearTimeout(retryTimer)
    const ctl = (events = new AbortController())
    const retry = () => {
      if (ctl.signal.aborted) return
      retryTimer = setTimeout(connectEvents, retryMs)
      retryMs = Math.min(retryMs * 2, 60000)
    }
    pageFetch("/api/event", {
      credentials: "include",
      headers: authHeaders({ accept: "text/event-stream" }),
      signal: ctl.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.body) return retry()
        retryMs = 1000
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buf = ""
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += value
          let i
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).replace(/^ /, ""))
              .join("\n")
            if (!data) continue
            try {
              const msg = JSON.parse(data)
              if (msg && msg.type === "rpc.cpa-quota.changed" && msg.data) apply(msg.data)
            } catch {}
          }
        }
        retry()
      })
      .catch(retry)
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const CSS = `
.cpa-quota-line{all:unset;box-sizing:border-box;display:block;pointer-events:auto;align-self:center;
  margin-top:6px;padding:2px 12px;max-width:100%;font:12px/18px var(--font-family-sans,Inter,system-ui,sans-serif);
  font-variant-numeric:tabular-nums;color:var(--text-weak,#9a9a9a);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;cursor:pointer;border-radius:6px;transition:color .15s,background-color .15s}
.cpa-quota-line:hover{background:var(--surface-raised-base,rgba(255,255,255,.04))}
.cpa-quota-line:focus-visible{outline:1px solid var(--border-base,#555);outline-offset:1px}
.cpa-quota-t-provider{color:var(--text-base,#d4d4d4);font-weight:500}
.cpa-quota-logo{display:inline-block;flex:none;box-sizing:content-box;width:14px;height:14px;max-width:none;margin:0 5px 0 0;
  padding:0;border:0;vertical-align:middle;position:relative;top:-1px;color:var(--text-weak,#8a8a8a)}
.cpa-quota-prov>.cpa-quota-logo{width:16px;height:16px;margin:0;top:0}
.cpa-quota-logo>svg{display:block;width:100%;height:100%}
.cpa-quota-logo-codex{color:var(--text-strong,#fff)}
.cpa-quota-t-label,.cpa-quota-t-stale{color:var(--text-weak,#8a8a8a)}
.cpa-quota-t-ok{color:var(--icon-success-base,#4ade80)}
.cpa-quota-t-warn{color:var(--icon-warning-base,#facc15)}
.cpa-quota-t-critical{color:var(--icon-critical-base,#f87171)}
.cpa-quota-t-empty{color:var(--icon-critical-base,#f87171);opacity:.6}
.cpa-quota-pop{position:fixed;z-index:2147483000;box-sizing:border-box;width:min(480px,calc(100vw - 16px));
  overflow:auto;padding:14px 16px 16px;border-radius:12px;background:var(--surface-float-base,var(--surface-raised-base,#1c1c1c));
  border:1px solid var(--border-weak-base,rgba(255,255,255,.08));color:var(--text-base,#d4d4d4);
  box-shadow:0 12px 32px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.2);
  font:12px/18px var(--font-family-sans,Inter,system-ui,sans-serif);font-variant-numeric:tabular-nums;
  animation:cpa-quota-in .14s ease-out}
@keyframes cpa-quota-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.cpa-quota-head{display:flex;align-items:baseline;gap:8px;margin-bottom:12px}
.cpa-quota-title{font-size:13px;font-weight:600;color:var(--text-strong,#f2f2f2)}
.cpa-quota-status{color:var(--text-weak,#8a8a8a)}
.cpa-quota-btn{all:unset;cursor:pointer;color:var(--text-weak,#8a8a8a);padding:0 4px;border-radius:4px}
.cpa-quota-btn:hover{color:var(--text-base,#d4d4d4);background:var(--surface-raised-base,rgba(255,255,255,.06))}
.cpa-quota-btn:first-of-type{margin-left:auto}
.cpa-quota-group+.cpa-quota-group{margin-top:12px;padding-top:12px;border-top:1px solid var(--border-weak-base,rgba(255,255,255,.08))}
.cpa-quota-acct+.cpa-quota-acct{margin-top:10px}
.cpa-quota-acct-head{display:flex;gap:8px;align-items:baseline;min-width:0;margin-bottom:4px}
.cpa-quota-prov{flex:none;font-weight:600;color:var(--text-base,#d4d4d4)}
.cpa-quota-prov-logo{align-self:center;display:flex;width:16px;height:16px}
.cpa-quota-name{font-weight:600;color:var(--text-strong,#f2f2f2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpa-quota-plan{color:var(--text-weak,#8a8a8a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cpa-quota-body{padding-left:12px}
.cpa-quota-wins{display:grid;grid-template-columns:fit-content(40%) 64px 34px minmax(0,1fr);column-gap:10px;row-gap:2px;align-items:baseline}
.cpa-quota-win{display:contents}
.cpa-quota-wlabel{color:var(--text-weak,#8a8a8a);overflow-wrap:anywhere}
.cpa-quota-bar{align-self:start;margin-top:7px;height:4px;border-radius:2px;background:var(--border-weak-base,rgba(255,255,255,.1));overflow:hidden}
.cpa-quota-bar>i{display:block;height:100%;border-radius:2px;background:currentColor}
.cpa-quota-pct{text-align:right}
.cpa-quota-meta{display:flex;flex-wrap:wrap;column-gap:8px;color:var(--text-weak,#8a8a8a)}
.cpa-quota-meta>span{white-space:nowrap}
.cpa-quota-meta>b{font-weight:400;color:var(--text-base,#d4d4d4);white-space:nowrap}
.cpa-quota-note{color:var(--text-weak,#8a8a8a)}
.cpa-quota-err{color:var(--icon-critical-base,#f87171);overflow-wrap:anywhere}
.cpa-quota-msg{color:var(--text-base,#d4d4d4)}
.cpa-quota-msg.cpa-quota-muted{color:var(--text-weak,#8a8a8a)}
@media (max-width:600px){
  .cpa-quota-line{white-space:normal;overflow:visible;text-overflow:clip}
  .cpa-quota-line>span{white-space:nowrap}
}
@media (max-width:420px){
  .cpa-quota-pop{overflow-x:hidden;padding:12px}
  .cpa-quota-body{padding-left:8px}
  .cpa-quota-wins{grid-template-columns:fit-content(30%) 40px 34px minmax(0,1fr);column-gap:8px}
  .cpa-quota-meta>span,.cpa-quota-meta>b{white-space:normal;overflow-wrap:anywhere}
}
@media (pointer:coarse){
  .cpa-quota-line{padding:6px 12px}
  .cpa-quota-btn{padding:6px 10px}
}
`

  // ---------------------------------------------------------------------------
  // DOM helpers and rendering
  // ---------------------------------------------------------------------------

  function el(tag, cls, text) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = text
    return n
  }

  /** Provider logo: inline mono SVG drawn in the current text colour (follows the theme). */
  const hasLogo = (provider) => !!LOGOS[provider]
  function logo(provider, fallback) {
    if (!hasLogo(provider)) return fallback()
    const span = el("span", `cpa-quota-logo cpa-quota-logo-${provider}`)
    span.title = provider
    span.setAttribute("role", "img")
    span.setAttribute("aria-label", provider)
    span.innerHTML = LOGOS[provider] // trusted, generated constant
    return span
  }


  const line = el("button", "cpa-quota-line")
  line.type = "button"
  line.title = "Subscription quotas — click for details"
  line.addEventListener("click", (e) => {
    e.stopPropagation()
    state.open ? closePopover() : openPopover()
  })

  let pop // popover element while open
  let activeProvider

  function lineSegments() {
    const snap = state.snapshot
    if (state.unavailable && !snap) return [seg("quota: n/a", "stale")]
    if (snap && !snap.configured) return [seg("quota: set CPA_MANAGEMENT_URL and CPA_MANAGEMENT_KEY", "warn")]
    if (snap && snap.rejected) return [seg(`quota: ${snap.rejected}, paused — click to retry`, "critical")]
    if (!snap || !snap.accounts) return [seg("quota …", "stale")]
    const list = compactSegments(snap.accounts, activeProvider, Date.now())
    return list.length ? list : [seg(snap.failed ? "quota: n/a" : "", "stale")]
  }

  function renderLine() {
    const segs = lineSegments()
    const text = (s) => el("span", `cpa-quota-t-${s.tone}`, s.text)
    line.replaceChildren(...segs.map((s) => (s.provider ? logo(s.provider, () => text(s)) : text(s))))
    line.style.display = segs.some((s) => s.text) ? "" : "none"
  }

  function popoverMessage() {
    const snap = state.snapshot
    if (snap && snap.accounts) return undefined
    if (state.loading) return "Loading…"
    if (state.failedCall || !snap) return "Failed to fetch quotas."
    if (!snap.configured) return "Set CPA_MANAGEMENT_URL (or the url option) and CPA_MANAGEMENT_KEY in the environment."
    if (snap.rejected)
      return `Management API: ${snap.rejected}. Check CPA_MANAGEMENT_KEY; after 5 failed attempts the proxy bans the IP for 30 minutes. Auto-refresh is paused.`
    return "Failed to fetch quotas from the management API."
  }

  function renderAccount(provider, a, first) {
    const box = el("div", "cpa-quota-acct")
    const head = el("div", "cpa-quota-acct-head")
    // Provider logo (or name) inline, only on its first account (like the TUI dialog).
    if (first) {
      const prov = el("span", "cpa-quota-prov")
      const img = logo(provider, () => {
        prov.classList.remove("cpa-quota-prov-logo")
        return document.createTextNode(provider)
      })
      if (img.nodeType === 1) prov.classList.add("cpa-quota-prov-logo")
      prov.append(img)
      head.append(prov)
    } else if (hasLogo(provider)) head.append(el("span", "cpa-quota-prov cpa-quota-prov-logo")) // spacer: names stay aligned
    head.append(el("span", "cpa-quota-name", a.account))
    if (a.plan) head.append(el("span", "cpa-quota-plan", `· ${a.plan}`))
    box.append(head)

    // Window rows, errors and stale notes share one indent under the header.
    const body = el("div", "cpa-quota-body")
    if (a.error) body.append(el("div", "cpa-quota-err", `error: ${a.error}`))
    else if (!a.windows.length) body.append(el("div", "cpa-quota-note", "no quota data"))
    if (a.windows.length) {
      // One grid per account: label column fits this account's labels only.
      const wins = el("div", "cpa-quota-wins")
      for (const w of a.windows) {
        const row = el("div", "cpa-quota-win")
        const bar = el("div", `cpa-quota-bar cpa-quota-t-${w.tone}`)
        const fill = el("i")
        fill.style.width = `${Math.max(0, Math.min(100, w.remainingPct))}%`
        bar.append(fill)
        // Detail and reset are separate nowrap chunks: they wrap onto two lines rather than get cut.
        const meta = el("span", "cpa-quota-meta")
        if (w.detail) meta.append(el("b", "", w.detail))
        if (w.reset) meta.append(el("span", "", `resets in ${w.reset}`))
        row.append(el("span", "cpa-quota-wlabel", w.label), bar, el("span", `cpa-quota-pct cpa-quota-t-${w.tone}`, w.pct), meta)
        wins.append(row)
      }
      body.append(wins)
    }
    if (a.stale) body.append(el("div", "cpa-quota-note", a.stale))
    box.append(body)
    return box
  }

  function renderPopover() {
    if (!pop) return
    const snap = state.snapshot
    const head = el("div", "cpa-quota-head")
    head.append(el("span", "cpa-quota-title", "Subscription quotas"))
    if (snap && snap.accounts && (state.loading || state.failedCall))
      head.append(el("span", "cpa-quota-status", state.loading ? "updating…" : "update failed"))
    const again = el("button", "cpa-quota-btn", "refresh")
    again.type = "button"
    again.addEventListener("click", () => refresh(true))
    const esc = el("button", "cpa-quota-btn", "esc")
    esc.type = "button"
    esc.addEventListener("click", closePopover)
    head.append(again, esc)

    const body = el("div")
    const msg = popoverMessage()
    if (msg) body.append(el("div", `cpa-quota-msg${state.loading ? " cpa-quota-muted" : ""}`, msg))
    else {
      const groups = reportGroups(snap.accounts, Date.now())
      if (!groups.length) body.append(el("div", "cpa-quota-msg cpa-quota-muted", "No accounts found."))
      for (const g of groups) {
        const gb = el("div", "cpa-quota-group")
        g.accounts.forEach((a, i) => gb.append(renderAccount(g.provider, a, i === 0)))
        body.append(gb)
      }
    }
    pop.replaceChildren(head, body)
    positionPopover()
  }

  function positionPopover() {
    if (!pop) return
    const r = line.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const w = pop.offsetWidth
    pop.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`
    pop.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`
    pop.style.maxHeight = `${Math.max(160, r.top - 16)}px`
  }

  function openPopover() {
    if (pop) return
    state.open = true
    pop = el("div", "cpa-quota-pop")
    pop.setAttribute("role", "dialog")
    pop.setAttribute("aria-label", "Subscription quotas")
    document.body.append(pop)
    refresh(true) // renders "updating…" immediately, then the fresh report
  }

  function closePopover() {
    state.open = false
    state.failedCall = false
    if (pop) pop.remove()
    pop = undefined
  }

  function render() {
    renderLine()
    renderPopover()
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pop) {
      e.stopPropagation()
      closePopover()
    }
  }, true)
  document.addEventListener("pointerdown", (e) => {
    if (pop && !pop.contains(e.target) && !line.contains(e.target)) closePopover()
  }, true)
  window.addEventListener("resize", positionPopover)

  // ---------------------------------------------------------------------------
  // Placement: keep the line under the composer as the SPA re-renders/navigates
  // ---------------------------------------------------------------------------

  function sync() {
    const form = document.querySelector('[data-component="composer"]')
    const dock = form && form.closest('[data-component="session-composer-dock"]')
    if (!form || !dock) {
      if (line.isConnected) line.remove()
      if (pop) closePopover()
      return
    }
    if (line.parentNode !== dock || line.previousElementSibling !== form) form.after(line)
    const width = `${Math.round(form.getBoundingClientRect().width)}px`
    if (line.style.width !== width) line.style.width = width

    const modelBtn = form.querySelector('button[data-action="composer-model"]')
    const provider = providerForModel(modelBtn ? modelBtn.textContent : "")
    if (provider !== activeProvider) {
      activeProvider = provider
      renderLine()
    }
  }

  let scheduled = false
  function scheduleSync() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      sync()
    })
  }

  const ours = (n) => n === line || line.contains(n) || (pop && (n === pop || pop.contains(n)))
  const observer = new MutationObserver((records) => {
    if (records.every((r) => ours(r.target))) return
    scheduleSync()
  })
  window.addEventListener("resize", scheduleSync)

  function start() {
    const style = el("style")
    style.id = "cpa-quota-style"
    style.textContent = CSS
    document.head.append(style)

    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    ready = true
    render()
    sync()
    refresh(false)
    connectEvents()
    setInterval(() => refresh(false), 5 * 60 * 1000) // fallback if the event stream drops
    setInterval(render, 60 * 1000) // keep reset countdowns fresh
  }
  // Runs at document-start (to wrap fetch before the app); the DOM comes later.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true })
  else start()

  // ---------------------------------------------------------------------------
  // Provider logos — GENERATED from @lobehub/icons (MIT): claude-color, codex (mono, currentColor). Do not edit by hand.
  // ---------------------------------------------------------------------------

  function logoData() {
    return {
    claude:
      "<svg aria-hidden='true' viewBox='0 0 24 24'><path d='M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z' fill='#D97757' fill-rule='nonzero'></path></svg>",
    codex:
      "<svg aria-hidden='true' fill='currentColor' fill-rule='evenodd' viewBox='0 0 24 24'><path clip-rule='evenodd' d='M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z'></path></svg>",
    }
  }
})()
