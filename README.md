# opencode-cpa-quota

OpenCode V2 plugin (server + TUI): shows subscription quotas (Claude, Codex, Antigravity, Kimi) from a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) management API in the prompt footer.

Requirements: OpenCode V2, a CLIProxyAPI instance with the management API enabled, and (for Claude) the `five-hour-quota-router` CPA plugin.

## Architecture

- **Server plugin** (`server.ts` → `src/server.ts`) reads the env/options, fetches and polls quotas, handles backoff and 401/403 pausing, and publishes snapshots over RPC (`cpa-quota`: method `get`, event `changed`; contract in `src/rpc.ts`).
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
On 401/403 from the management API, polling stops (the proxy bans an IP after
5 failed attempts); run `/quota` to retry.

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
