# dsh-bas-remote

SAP Business Application Studio (BAS) remote dev spaces for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Reproduces the
["Remote Access for SAP Business Application Studio"](https://github.com/SAP/app-studio-toolkit)
workflow without VS Code: sign in to a BAS landscape, list its dev spaces, and open
an SSH dev-channel tunnel that any SSH client or the harness remote-workspace
tools (`rw_connect`) can use.

## Features

- **Landscape sign-in** — browser hand-off (`/ext-login.html`) with
  loopback token listener.
- **Dev-space listing** — read-only view of running/starting/stopped spaces.
- **Dev-space lifecycle** — start (resume) and stop (suspend) a dev space, the
  same way the VS Code Dev Space Manager does, and `bas_connect` starts a
  stopped space before opening the tunnel.
- **Dev-channel tunnel** — WebSocket-to-SSH bridge via
  `@microsoft/dev-tunnels-ssh` (same libraries as the VS Code extension).
- **`~/.ssh/config` management** — automatic `Host` entry per connected
  space (optional, toggleable).
- **Model tools** — `bas_status`, `bas_login`, `bas_logout`, `bas_devspaces`,
  `bas_start`, `bas_stop`, `bas_connect`, `bas_disconnect`, `bas_forget`.
- **Human command** —
  `/bas status|login|devspaces|start|stop|connect|disconnect|logout|forget`.
- **Web panel** — settings section in the harness Web UI with one-click
  start / stop / connect / disconnect and live polling.

## Bundle use

Add to a profile's bundle list in your `nix-config`:

```nix
programs.dsh.profiles.web.bundles = [ nur.packages.${system}.dsh-bas-remote ];
```

The plugin requires the base profile bundle (`@deepseek-ai/dsh-credentials`,
`@deepseek-ai/dsh-tools`, etc.) which is always present in standard
compositions.

## What a connection actually is

Connecting a dev space does not open a proprietary API session — it ends in an
ordinary SSH endpoint. The dev-channel is a standard SSH transport, wrapped in a
WebSocket because that is the only egress the landscape exposes:

1. the landscape hands out the dev space's runtime URL, and its SSH private key
   comes from `GET <runtime startup url>/key`,
2. the plugin opens `wss://port33765-<host>:443` and speaks the SSH transport
   protocol (`kex`, auth, channels) over it with `@microsoft/dev-tunnels-ssh` —
   the same libraries the VS Code extension uses,
3. `PortForwardingService` forwards a loopback TCP port
   (`127.0.0.1:<local>`) to the dev space's sshd on `127.0.0.1:2222`,
4. the fetched key and a marked `~/.ssh/config` `Host` block are published for
   whichever client connects next.

From there it is plain SSH, which is the whole point: it serves remote
development against the dev space — a Remote-SSH style editor session, a remote
shell, file editing and syncing, builds and tests, `scp`/`rsync`, and the
harness remote-workspace tools (`rw_connect`) that adopt the dev space as a
remote workspace. That is the same capability the upstream extension provides.

## Dev-space lifecycle

A dev space that is `STOPPED` has no runtime URL, so there is nothing to tunnel
into; the VS Code extension starts such a space first and so does this plugin.

| Action | Call |
|--------|------|
| start (resume) | `PUT <landscape>/ws-manager/api/v1/workspace/<id>` with `{"Suspended": false, "WorkspaceDisplayName": "<name>"}` |
| stop (suspend) | same `PUT` with `{"Suspended": true, ...}` |

`bas_start` / `/bas start <dev space>` waits until the runtime reports
`RUNNING`, `bas_stop` / `/bas stop <dev space>` waits for `STOPPED` and closes
any tunnel into the space first (the dev channel dies with the runtime).
`bas_connect` runs the start path implicitly, which is why connecting a stopped
dev space now works instead of failing on "no startup URL".

BAS runs at most **two** dev spaces per landscape at a time — the toolkit
enforces the same limit (`isItPossibleToStart` in `devspace-manager`) — so a
start is refused with the names of the spaces holding the slots. Statuses are
`RUNNING`, `STARTING`, `STOPPED`, `STOPPING`, `ERROR` and `SAFE_MODE`.

## Upstream reference

- **SAP/app-studio-toolkit** — https://github.com/SAP/app-studio-toolkit
  - `packages/app-studio-remote-access` — the VS Code extension whose sign-in,
    dev-space and dev-channel behaviour this plugin mirrors without VS Code;
  - `packages/app-studio-toolkit/src/devspace-manager` — the start/stop, create
    and delete actions mirrored by `bas_start` / `bas_stop`.

## Protocol notes

This plugin re-implements, in plain Node.js without `@sap/bas-sdk`, the
exact HTTP calls that the SAP `app-studio-toolkit` extensions make:

| Call | Source |
|------|--------|
| `GET <landscape>/ext-login.html?cb=<n>` | `auth-utils.ts` |
| `POST /ext-login` (loopback) | `auth-utils.ts` |
| `GET <landscape>/ws-manager/api/v1/workspace` | `get-devspace.ts` |
| `GET <landscape>/ws-manager/api/v1/workspace/<id>` | `get-devspace.ts` |
| `PUT <landscape>/ws-manager/api/v1/workspace/<id>` (`Suspended`) | `devspace/update.ts`, `devspace-utils.ts` |
| `GET <runtime startup url>/key` | `devspace-utils.ts` |
| `wss://port33765-<host>:443` (SSH over WebSocket) | `ssh.ts` |

The dev-channel WebSocket carries a standard SSH transport; the plugin
activates `PortForwardingService` to forward `127.0.0.1:<local>` to
`127.0.0.1:2222` (the dev space's sshd), then writes a `~/.ssh/config`
`Host` block pointing at that port.

## License

Apache-2.0 (matching the upstream SAP extension).
