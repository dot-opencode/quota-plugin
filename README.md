# opencode-cpa-quota

OpenCode V2 plugin (server + TUI): shows subscription quotas (Claude, Codex) from a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance in the prompt footer.

Requirements: OpenCode V2, a CLIProxyAPI instance with the (updated) `five-hour-quota-router` CPA plugin, whose quota route this plugin reads. Its CPA config needs `plugins.configs.five-hour-quota-router.quota-api-keys: [...]`; the key you put there is `CPA_QUOTA_KEY`.

## Architecture

- **Base** (`src/base.ts`, `src/server.ts`): generic and source-agnostic. Polling timer, 30 s result cache (`force` skips it), in-flight dedupe, per-account backoff (5 min doubling to 30 min, or `Retry-After`), per-provider min interval, and persisted state (keys `source:provider:key`; legacy `provider:auth_index` keys migrate to `cpa:`). It publishes snapshots over RPC (`cpa-quota`: method `get`, event `changed`; contract in `src/rpc.ts`). The snapshot carries `accounts`, `providers` (metadata of all registered sources) and `rejected` (e.g. `cpa: invalid key (401)`).
- **Sources** (`src/source.ts`, public as `opencode-cpa-quota/source`): a `QuotaSource` lists accounts and fetches quotas for them; sources are independent (one failing never blocks another). The registry lives on `globalThis`, see below.
- **Built-in CPA source** (`src/sources/cpa/`): the CLIProxyAPI implementation (quota route client, Claude/Codex parsers). The server plugin registers it when both the URL and key are present.
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

- `CPA_URL` (required unless the `url` option is set) — base URL of the CLIProxyAPI server, e.g. `https://cpa.example.com`.
- `CPA_QUOTA_KEY` (required) — one of the keys in `plugins.configs.five-hour-quota-router.quota-api-keys`.

Plugin options: `url` (overrides `CPA_URL`), `refreshSec` (default 300, minimum 30). Without a URL or key the footer shows `quota: set CPA_URL and CPA_QUOTA_KEY`.

Both providers come from one request per poll:
`GET {url}/v0/resource/plugins/five-hour-quota-router/quota` with `Authorization: Bearer <CPA_QUOTA_KEY>`.
The response is `{ "claude": <router status>, "codex": [{ auth_index, email?, label?, usage?, error?, retry_after_ms?, fetched_at? }] }`;
accounts come from the response (keyed by `auth_index`), and Codex `usage` is the raw
`wham/usage` JSON. `401` shows `CPA quota key rejected (401)`, `404` means the
`five-hour-quota-router` plugin must be updated and `quota-api-keys` configured; polling
continues normally in both cases. When a Codex entry carries an `error` (e.g. 429), its last
known values stay on screen, and that account is retried after 5 min, doubling up to
30 min (or `retry_after_ms`, if longer). `/quota` skips the 30 s result cache but
respects these pauses. This state is persisted in
`${XDG_CACHE_HOME:-~/.cache}/opencode-cpa-quota/state.json` and re-read before each
refresh, so restarts and other processes sharing the file see the same pauses.
The server loads the plugin many times (each copy gets its own module instance), so all
mutable state lives in one store on `globalThis[Symbol.for("opencode-cpa-quota.state")]`:
one poller and one timer per process, regardless of the number of projects or copies.

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
