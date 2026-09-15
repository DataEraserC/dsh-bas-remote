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
- **Dev-space listing** — one card per space with running/starting/stopped
  state and whether its SSH key is being served (probed, not guessed).
- **Dev-space lifecycle** — start (resume) and stop (suspend) a dev space, the
  same way the VS Code Dev Space Manager does, and `bas_connect` starts a
  stopped space before opening the tunnel.
- **Dev-channel tunnel** — WebSocket-to-SSH bridge via
  `@microsoft/dev-tunnels-ssh` (same libraries as the VS Code extension).
- **SSH endpoint publishing** — off by default (nothing on your disk is
  touched; the ready-to-paste `Host` block is reported instead). Opt in to a
  fragment file this plugin owns, or to editing `~/.ssh/config` itself.
- **SFTP where the dev space has none** — a BAS dev space's sshd is dropbear
  without an `sftp-server`, so `rw_stat`, `rw_read_file`, `rw_write_file`,
  `rw_sync`, `rw_push` and dsh-remote's mirror/pick normally fail with
  `not a directory (or unreachable)`. On connect the plugin installs a small
  SSH server (exec **and** SFTP) inside the dev space and forwards it over the
  same dev channel, so one endpoint serves everything. `sftpBridge: false`
  turns that off.
- **Model tools** — `bas_status`, `bas_login`, `bas_logout`, `bas_devspaces`,
  `bas_start`, `bas_stop`, `bas_connect`, `bas_disconnect`, `bas_bridge`,
  `bas_forget`.
- **Human command** —
  `/bas status|login|devspaces|start|stop|connect|disconnect|logout|forget`.
- **Web panel** — settings section in the harness Web UI with one-click
  start / stop / connect / disconnect and live polling, plus a compact
  floating chip (bottom right) showing the number of live tunnels and, on
  click, their `ssh`/`sftp` endpoints.

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
4. the fetched key lands in the SSH directory and the `Host` block for the
   next client is published according to `sshConfigMode` (by default only
   reported, so a managed `~/.ssh/config` is never rewritten).

From there it is plain SSH, which is the whole point: it serves remote
development against the dev space — a Remote-SSH style editor session, a remote
shell, builds and tests, `scp`/`tar`, and the harness remote-workspace tools
(`rw_connect`) that adopt the dev space as a remote workspace. That is the same
capability the upstream extension provides.

### What a BAS dev space can and cannot serve

The dev space's own sshd is **dropbear** and the image ships no `sftp-server`
(`/usr/lib/sftp-server` does not exist; the image has no root and `/usr/lib` is
read-only), so over the plain dev-channel endpoint:

| Capability | Works? | Evidence over a live tunnel |
|------------|--------|-----------------------------|
| exec channels (`ssh <cmd>`, `rw_exec`) | yes | `whoami` → `user`, `HOME=/home/user` |
| forwarding to another dev-space port | yes | dropbear answers on the forwarded port |
| SFTP subsystem | **no** | `sftp` → `bash: /usr/lib/sftp-server: No such file or directory`, ssh2 → `Received exit code 127 while establishing SFTP session` |
| legacy `scp -O` | yes | push verified by `md5sum` inside the dev space |
| `tar` over an exec channel | yes | `tar` is installed; no `rsync` |

That is why the plugin runs its own SSH server **inside** the dev space (the
[SFTP bridge](#sftp-bridge)) and reports *its* endpoint for `rw_connect`: on
that endpoint `rw_stat`, `rw_read_file`, `rw_write_file`, `rw_sync`, `rw_push`
and dsh-remote's mirror/pick work, because SFTP is what they use. Without the
bridge, file transfer still works over `scp -O` or `tar | ssh`, which
`bas_connect` prints with the right port and key.

## SFTP bridge

A BAS dev space has no SFTP server and no way to install one (no root,
`/usr/lib` is read-only), so this plugin brings its own:

1. on connect, `lib/bridge-server.cjs` is uploaded to
   `~/.dsh-bas-remote/sftp-bridge/` in the dev space and `ssh2` is installed
   once with the dev space's own npm (BAS images ship node and npm; the install
   takes a few seconds at ~1 MB);
2. an ed25519 host key is generated there, and the server authorises exactly
   **one** key: the dev-space key the landscape handed out;
3. the daemon listens on `127.0.0.1:2223` *inside* the dev space (never on an
   external interface) as the dev-space user, so file permissions are the user's;
4. the dev channel forwards that loopback port to a second local port, and the
   plugin verifies the whole path (forward → handshake → `stat("/")`) before it
   advertises it.

Both endpoints then exist side by side:

| Port | Serves | Use for |
|------|--------|---------|
| dropbear (the dev space's own sshd) | exec, port forwarding | `ssh`, `scp -O`, `tar \| ssh` |
| SFTP bridge | exec **and** SFTP | `rw_connect` (all `rw_*` tools), dsh-remote mirror/pick |

Lifecycle: the bridge is (re)started on every connect, cached between connects
(script hash + `node_modules`), and stopped on `bas_disconnect`. A daemon left
behind by a dropped tunnel is replaced on the next connect. `bas_bridge` reports
its state (installed, running, pid, listening, log tail) and can stop it.

| Config | Default | Meaning |
|--------|---------|---------|
| `sftpBridge` | `true` | provide SFTP in connected dev spaces |
| `sftpBridgePort` | `2223` | port the bridge listens on inside the dev space |
| `sftpBridgeDir` | `.dsh-bas-remote/sftp-bridge` | where it is installed (`~`-relative) |
| `sftpBridgeInstall` | `true` | allow the one-time `npm install ssh2` in the dev space |
| `sftpBridgeTimeoutMs` | `300000` | ceiling for the first-time setup |

If the bridge cannot start (npm unreachable, quota, an image without node), the
connect still succeeds, the result says `SFTP bridge … unavailable: <reason>`,
and the endpoint stays exec-only. `sftpBridge: false` skips it entirely.

`npm test` covers the bridge server and the client trees without a dev space.
`npm run test:live` drives the real plugin against a signed-in landscape and
asserts, through the endpoint it reports, the SFTP calls the remote tools make
(`BAS_LANDSCAPE`, `BAS_DEVSPACE`, optional `BAS_JWT`).

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

## SSH endpoint publishing

Nothing outside the plugin's own key directory is written unless you ask for it:

| `sshConfigMode` | Effect |
|-----------------|--------|
| `off` *(default)* | no file is touched; `bas_connect` reports the key path, the loopback endpoint and the exact `Host` block to paste |
| `fragment` | maintains `<sshDir>/dsh-bas-remote.conf` (marked blocks, cleaned up on disconnect); add `Include ~/.ssh/dsh-bas-remote.conf` to your own config |
| `config` | edits `sshConfigPath` (default `~/.ssh/config`) between this plugin's markers — the legacy `manageSshConfig: true` alias |

In every mode the write is refused when the target is a symlink (nix store,
home-manager), not a regular file, or not writable; `bas_connect` then reports
the reason and the block instead of failing. That makes the plugin safe on a
home-manager/nix-managed `~/.ssh/config`, which is normally immutable.

## SSH availability

A RUNNING dev space that has **no** remote-access or SSH entry in its
`optionalExtensions` annotation can still serve its key, so SSH availability is
*probed*: the plugin requests `GET <runtime startup url>/key` (60 s cache) and
reports `ssh: key available`, `ssh: no key from the runtime`, or
`ssh: not probed (start it first)`. The key endpoint is the only reliable
signal — the annotation is not.

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
