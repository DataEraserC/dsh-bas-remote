# Changelog

## 0.3.0

### Features
- Dev-space lifecycle control, mirroring the SAP VS Code extension's Dev Space Manager: `PUT <landscape>/ws-manager/api/v1/workspace/<id>` with `{"Suspended": false|true, "WorkspaceDisplayName": "<name>"}` starts (resumes) and stops (suspends) a dev space. New model tools `bas_start` and `bas_stop`, new `/bas start|stop` subcommands, and a non-blocking `/bas-remote/devspace` route.
- `bas_connect` starts a `STOPPED` dev space first and waits for `RUNNING` before fetching the key and opening the tunnel, instead of failing on an empty startup URL. Start/stop waits poll the runtime status (ceiling: `devSpaceTimeoutMs`, default 240 s).
- The BAS limit of two running or starting dev spaces per landscape is enforced with the names of the spaces holding the slots, as `isItPossibleToStart` does upstream.
- Web UI: per-dev-space **Start** / **Stop** buttons, neutral grey for `STOPPED`, amber for `STARTING`/`STOPPING`, red for `ERROR`/`SAFE_MODE`, a live "Starting…"/"Stopping…" state that follows the status until it settles, and a "Connecting…" state for the connect action.

### Fixes
- `getDevSpaceKey` no longer reports a missing startup URL as "enable the Remote Access extension" when the real cause is a dev space that is not running; the error now names the runtime status.

## 0.2.2

### Fixes
- Web UI: the settings page showed a red status dot and a "Sign in" button even while signed in. `/bas-remote/state` answers `{ ok, state, auth }` — `auth` is a sibling of `state` — but the page stored only `state` and every consumer reads `state.auth`, so `signedIn` was always false. The auth states are now merged into the stored snapshot, which also unblocks the automatic dev-space fetch.

### Documentation
- Explain that a connection ends in a standard SSH transport over the dev-channel WebSocket (remote development, editors, `rw_connect`), and link the upstream [SAP/app-studio-toolkit](https://github.com/SAP/app-studio-toolkit) reference.

## 0.2.1

### Fixes
- Sign-in no longer fails with `credential key segment "…" must match /^[a-z][a-z0-9-]*$/`: the credential store only admits lowercase hyphenated key segments, which a BAS landscape host never is (dotted, often digit-leading), so every browser hand-off failed at the store step. The record id is now a slug of the landscape host plus a short digest of the exact host.

## 0.2.0

### Features
- Web UI: shell overlay status pill showing active tunnel count (click to open settings)

## 0.1.0

Initial release.

### Features
- Landscape sign-in via browser hand-off (`/ext-login.html`)
- Dev-space listing via `ws-manager/api/v1/workspace` API
- SSH dev-channel tunnel using `@microsoft/dev-tunnels-ssh`
- `~/.ssh/config` management with marked blocks
- 7 model tools: `bas_status`, `bas_login`, `bas_logout`, `bas_forget`, `bas_devspaces`, `bas_connect`, `bas_disconnect`
- `/bas` slash command with subcommands
- Web client settings section panel
