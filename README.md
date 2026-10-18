# opencode-cpa-quota

OpenCode V2 plugin (server + TUI): shows subscription quotas (Claude, Codex, Antigravity, Kimi) from a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) management API in the prompt footer.

Requirements: OpenCode V2, a CLIProxyAPI instance with the management API enabled, and (for Claude) the `five-hour-quota-router` CPA plugin.

## Architecture

- **Base** (`src/base.ts`, `src/server.ts`): generic and source-agnostic. Polling timer, 30 s result cache (`force` skips it), in-flight dedupe, per-account backoff (5 min doubling to 30 min, or `Retry-After`), per-provider min interval, and persisted state (keys `source:provider:key`; legacy `provider:auth_index` keys migrate to `cpa:`). It publishes snapshots over RPC (`cpa-quota`: method `get`, event `changed`; contract in `src/rpc.ts`). The snapshot carries `accounts`, `providers` (metadata of all registered sources) and `rejected` (e.g. `cpa: invalid key (401)`).
- **Sources** (`src/source.ts`, public as `opencode-cpa-quota/source`): a `QuotaSource` lists accounts and fetches quotas for them; sources are independent (one failing never blocks another). The registry lives on `globalThis`, see below.
- **Built-in CPA source** (`src/sources/cpa/`): the CLIProxyAPI implementation (management API client, Claude/Codex/Antigravity/Kimi parsers). The server plugin registers it when both the URL and key are present.
- **TUI plugin** (`tui.tsx` → `src/tui.tsx`) only displays: it calls `get` once, listens to `changed`, and `/quota` calls `get({ force: true })`. If the server plugin isn't loaded, the footer shows `quota: n/a`.

The env vars below are read by the server plugin (the OpenCode server process).

## Install

The package exposes both `./server` and `./tui` entries. Add it to `plugins` in `opencode.json(c)`; the CLI picks up the `./tui` entry automatically:

```json
{ "plugins": ["github:dot-opencode/quota-plugin#release"] }
```

The `release` branch points at the latest tagged release. A local checkout path works too.

Without the server entry the footer shows `quota: n/a`. Server options (`url`, `refreshSec`) go into the same entry: `{ "package": "...", "options": { ... } }`.

For a local checkout, run `bun install` in the plugin dir (dev deps only; Solid/OpenTUI come from OpenCode at runtime).

## Env

- `CPA_MANAGEMENT_URL` (required unless the `url` option is set) — base URL of the CLIProxyAPI server, e.g. `https://cpa.example.com`.
- `CPA_MANAGEMENT_KEY` (required) — management API key.

Plugin options: `url` (overrides `CPA_MANAGEMENT_URL`), `refreshSec` (default 300, minimum 30). Without a URL or key the footer shows `quota: set CPA_MANAGEMENT_URL and CPA_MANAGEMENT_KEY`.

Claude values come from the `five-hour-quota-router` CPA plugin status
(`GET {url}/v0/management/plugins/five-hour-quota-router/status`, one request per poll,
matched by `auth_index`); the plugin never calls Anthropic. Codex, Antigravity and Kimi
go through the management `api-call`. When such a usage endpoint fails (e.g. 429), the
last known values stay on screen, and that account is retried after 5 min, doubling up to
30 min (or the upstream `Retry-After`, if longer). `/quota` skips the 30 s result cache but
respects these pauses. This state is persisted in
`${XDG_CACHE_HOME:-~/.cache}/opencode-cpa-quota/state.json` and re-read before each
upstream request, so restarts and other processes sharing the file see the same pauses.
The server loads the plugin many times (each copy gets its own module instance), so all
mutable state lives in one store on `globalThis[Symbol.for("opencode-cpa-quota.state")]`:
one poller and one timer per process, regardless of the number of projects or copies.
On 401/403 from the management API, the CPA source stops being polled (the proxy bans an IP after
5 failed attempts); run `/quota` to retry.

## Custom sources

Other OpenCode plugins can add their own quota providers. A source implements `QuotaSource` from `opencode-cpa-quota/source`:

- `id`, `providers` (`ProviderMeta[]`: `id`, optional `name`, `providerIDs`, `modelPrefixes`, `modelPattern`, `logo` (absolute png path), `backoff`; `backoff: false` makes the base skip backoff and min-interval filtering for that provider);
- `listAccounts()` → `AccountRef[]` (`provider`, stable `key`, display `account`, optional `data`);
- `fetch(refs)` → `Map<ref.key, FetchResult>`: either quota data (`plan?`, `windows`, ...) or `{ error, retryAfterMs? }`. A missing key counts as an error. Accounts that are in backoff are not passed to `fetch`;
- optional `fatal(e)`: return a message for errors that must stop polling the source (e.g. a bad key); it appears in `snapshot.rejected` as `<id>: <message>` until a forced refresh succeeds.

Minimal plugin, in its own package:

```ts
import { Plugin } from "@opencode/plugin"
import { registerQuotaSource } from "opencode-cpa-quota/source"

export default Plugin.define({
  id: "my-quota",
  setup: async () => {
    const unregister = registerQuotaSource({
      id: "my-service",
      providers: [{ id: "myservice", name: "My Service", providerIDs: ["myservice"], modelPrefixes: ["my-"] }],
      listAccounts: async () => [{ provider: "myservice", key: "main", account: "me@example.com" }],
      fetch: async (refs) =>
        new Map(refs.map((r) => [r.key, { windows: [{ label: "5h", remainingPct: 80 }] }])),
    })
    return unregister // cleanup
  },
})
```

Registering a source with an existing id replaces it. The registry is stored on `globalThis[Symbol.for("opencode-cpa-quota.state")]`, so registration works even when your plugin and this one load separate module copies. The base polls as soon as a source is registered and drops its accounts when it is unregistered.

## Usage

The footer shows e.g. `claude 5h 64% · 7d 95%` for the current model's provider (all providers when unknown).
`/quota` (or the command palette) shows the full report with reset times.

## Web UI (userscript)

`web/cpa-quota.user.js` shows the same quota line under the composer in the OpenCode V2 web UI; click it for the full report (this also forces a refresh).
Install it with Tampermonkey or Violentmonkey: create a new script and paste the file, or open the raw file URL (it is also attached to each GitHub release).
Its `@match` lines cover `http://127.0.0.1/*` and `http://localhost/*` on any port; if you open the web UI on another host, add a `@match` line for it.
It needs the server plugin: it reads quotas from the `cpa-quota` RPC and event stream of the same server, and shows `quota: n/a` without it.

## Dev

`bun install`, then `bun test` and `bun run typecheck` (CI runs both).

Release: bump `version` in `package.json`, then push a `v<version>` tag. The workflow checks the tag, runs the tests, publishes a GitHub release and moves the `release` branch to the tag.

## License

MIT
