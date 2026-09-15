# Changelog

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
