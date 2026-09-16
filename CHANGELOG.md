# Changelog

## 0.4.2

### Fixed
- Settings page crashed with  when rendering the sftp rw_connect hint.

## 0.4.1

### Fixed
- Settings page now shows both the ssh and sftp endpoints (`ssh 127.0.0.1:PORT · sftp 127.0.0.1:PORT`) and the `rw_connect` command for the sftp port, so users know which port to use for remote workspace tools. Previously only the dropbear endpoint was shown.

## 0.4.0

### Added
- **SFTP in BAS dev spaces.** A dev space's sshd is dropbear and the image ships no `sftp-server` (`/usr/lib/sftp-server` is missing; no root, `/usr/lib` is read-only), so SFTP failed with exit code 127 and `rw_stat`, `rw_read_file`, `rw_write_file`, `rw_sync`, `rw_push` and dsh-remote's mirror/pick reported `not a directory (or unreachable)`. The plugin now installs its own SSH server **inside** the dev space (`lib/bridge-server.cjs`, exec **and** SFTP), listening on `127.0.0.1:2223` only, authorised with exactly the dev-space key the landscape handed out, and forwarded over the same dev channel. `bas_connect` reports that endpoint for `rw_connect`, so one port serves everything; the dropbear endpoint stays for plain `ssh`/`scp -O`/`tar`.
  - Setup is idempotent and cached in the dev space (`~/.dsh-bas-remote/sftp-bridge/`): the server is re-uploaded only when its hash changes and `ssh2` is installed once with the dev space's own npm (a few seconds, ~1 MB).
  - The forward is verified end to end (handshake + `stat("/")`) before it is advertised; if the bridge cannot start, the connect still succeeds and the result says `SFTP bridge … unavailable: <reason>`, leaving the endpoint exec-only.
  - New config: `sftpBridge` (default `true`), `sftpBridgePort` (2223), `sftpBridgeDir`, `sftpBridgeInstall`, `sftpBridgeTimeoutMs`.
  - New tool `bas_bridge` (`status` | `stop`) reporting installed/running/pid/listening and the daemon log tail. `bas_disconnect` stops the daemon before closing the tunnel; a daemon left behind by a dropped tunnel is replaced on the next connect.
- `test/bridge-server.test.mjs` (`npm test`): starts the real bridge server and asserts, with a real ssh2 client, that it refuses any other key and serves the full exec + SFTP surface (stat/readdir/read/write/fastPut/fastGet/mkdir/rename/unlink/rmdir/symlink/realpath, seconds-based timestamps, `NO_SUCH_FILE` for missing paths).

### Fixed
- **`bas_disconnect`/`bas_start` could not find a connected dev space by its id.** Tunnel keys are `<landscape>/<dev space id>` and the lookup sliced the key at the first `/`, which lands inside `https://`, so matching by id (or id prefix) never worked for a URL landscape; only the label or the full key did. Matching now uses the stored id/label.
- **The dev channel was given up on after one failed handshake.** `Failed to read the protocol version` (and similar) happens intermittently; `bas_connect` now retries the handshake up to `connectAttempts` times (default 3, 1.5 s/3 s backoff) before reporting the failure.
- The bridge daemon died on an unhandled ssh2 `client-timeout` (a client that vanishes — a killed harness, a dropped tunnel — makes the server's keepalive fail and emit `error`); those errors are now logged, and the daemon also survives an uncaught exception instead of disappearing mid-session.
- Replacing a stale bridge daemon now also kills the process owning the bridge port, so an older daemon that does not match the command-line pattern cannot keep the port occupied. The server writes its own pid file (`setsid` makes `$!` the wrapper, not node).

### Changed
- The shell chip (`BAS · N`) no longer dispatches a `dsh-navigate` event that nothing listens to: it opens its own panel listing the connected dev spaces with their `ssh` and `sftp` endpoints. The settings page lists both endpoints per tunnel as well.

## 0.3.2

### Fixes
- Web UI: the tunnel indicator rendered as a full-width translucent band across the top instead of a chip. `shell.overlay` renders each seat as a plain child of `.overlayLayer`, which spans the whole frame, so a block-level pill stretched to that width. It is now anchored as a compact chip (`position: absolute`, bottom-right, `width: max-content`) with a shadow and backdrop blur, and reads `BAS · N`.

### Changed
- `bas_connect` no longer tells you to `rw_pick_workspace` as if every remote tool worked. BAS dev spaces run dropbear without an `sftp-server` (`/usr/lib/sftp-server` is missing from the image), so the SFTP-based tools — `rw_stat`, `rw_read_file`, `rw_write_file`, `rw_sync`, `rw_push` and dsh-remote's mirror/pick (`not a directory (or unreachable)`) — cannot work there. The result now says so and prints the working alternatives (`scp -O`, `tar | ssh`) with the current port and key. Exec channels (`rw_exec`, `ssh <cmd>`) are unaffected.
- Tool descriptions for `bas_status`, `bas_connect` and `bas_disconnect` no longer claim a `~/.ssh/config` entry is always written.

### Documentation
- README: what a BAS dev space can and cannot serve, with the live evidence per capability (exec yes, SFTP no, legacy `scp -O` yes, `tar` yes, no `rsync`).

## 0.3.1

### Fixes
- **SSH was reported as unavailable on dev spaces that do serve SSH.** Availability was inferred from a `vscode…ssh` entry in the `optionalExtensions` annotation, which a BAS dev space does not need to expose its key: the plugin showed "SSH not enabled" and refused to connect on a dev space whose `GET <runtime startup url>/key` answered 200 with an OpenSSH key. Availability is now *probed* against that endpoint (60 s cache) and `sshEnabled` is tri-state — `true`, `false`, or `null` while the space is not running and nothing can be probed. `bas_connect` no longer refuses on the annotation and only reports the runtime when the key request itself fails.
- `bas_connect` in `fragment` mode wrote the fragment to `~/.ssh/dsh-bas-remote.conf` even when `sshDir`/`sshConfigPath` pointed elsewhere; it now resolves next to the key directory.

### Changed
- **Nothing is written to `~/.ssh/config` unless explicitly configured.** A nix/home-manager managed SSH config is normally immutable (this plugin's own environment showed the file as read-only) and any write would be reverted on the next switch. The new `sshConfigMode` is `off` by default: `bas_connect` then reports the key path, the loopback endpoint and the exact `Host` block to paste. `fragment` maintains `<sshDir>/dsh-bas-remote.conf` (marked blocks, removed on disconnect) for an `Include`; `config` keeps the previous behaviour and stays reachable through `sshConfigMode: 'config'` or the legacy `manageSshConfig: true`. Every mode refuses to write a target that is a symlink, not a regular file, or not writable, and reports why instead of failing.

### Features
- Web UI: every dev space in the list is now a card (status dot, name, state and SSH badge on one row; controls on the next; hints on their own line) so the "add the Remote Access extension" hint no longer pushes the Stop and Refresh buttons apart.
- Web UI: the SSH badge reflects the probed state, Connect appears for a running space whose key is available, and a connected space names its SSH alias, including when the entry was not published to any config.

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
