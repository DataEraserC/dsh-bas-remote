// dsh-bas-remote — SFTP bridge lifecycle (host side).
//
// A BAS dev space's sshd is dropbear and its image has no `sftp-server`, so
// SFTP over the dev channel fails with exit code 127 and every SFTP-based remote
// tool breaks. This module starts a small SSH server (`lib/bridge-server.cjs`)
// *inside* the dev space — where the user's own permissions apply — and the dev
// channel forwards its loopback port, giving the harness one endpoint that
// speaks exec + SFTP.
//
// Setup is idempotent and cached in the dev space (`~/.dsh-bas-remote/sftp-bridge`):
// the server source is uploaded only when its hash changes and `ssh2` is
// installed once with the dev space's own npm.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'

const { Client, utils } = ssh2

/**
 * The bridge server source, uploaded verbatim into the dev space.
 *
 * It is CommonJS on purpose (the dev space runs it with plain node) and lives
 * in a `.cjs` file so that this ESM package can hold it. The candidates cover a
 * bundler that moves `lib` around.
 */
function readServerSource() {
  const candidates = [
    './bridge-server.cjs',
    './bridge-server.js',
    '../lib/bridge-server.cjs',
    '../lib/bridge-server.js',
  ]
  for (const candidate of candidates) {
    try {
      return readFileSync(fileURLToPath(new URL(candidate, import.meta.url)), 'utf8')
    } catch {
      // Try the next layout.
    }
  }
  throw new Error('cannot locate bridge-server.cjs next to lib/bridge.js')
}

const SERVER_SOURCE = readServerSource()
const SERVER_SHA = createHash('sha256').update(SERVER_SOURCE).digest('hex')

/** Chunk size for the base64 upload: dropbear caps the exec command length. */
const UPLOAD_CHUNK = 3000

export const DEFAULT_BRIDGE_DIR = '.dsh-bas-remote/sftp-bridge'
export const DEFAULT_BRIDGE_PORT = 2223

/**
 * Pattern that finds a previous daemon of one bridge directory.
 *
 * It matches the *absolute* script path the daemon was started with, which is
 * the only reliable handle: `$!` after `setsid` is the wrapper, not node, and
 * `node server.js` alone does not name the directory.
 * @param {string} base - bridge directory inside the dev space.
 * @returns {string} an extended-regex pattern for pgrep/pkill.
 */
function daemonPattern(base) {
  return `${base}/server\\.js --port`
}

/** @param {string} value - shell argument. @returns {string} a quoted argument. */
function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** @param {string} command - command that must succeed. @param {object} result - exec result. */
function assertOk(command, result) {
  if (result.code === 0) return result
  const detail = (result.stderr || result.stdout || '').trim().slice(0, 300)
  throw new Error(`remote command failed (exit ${result.code}): ${command.slice(0, 120)}${detail ? ` — ${detail}` : ''}`)
}

/**
 * One authenticated SSH connection to a tunnel endpoint.
 * @param {object} options - connection options.
 * @param {number} options.port - loopback port of the forwarded dev space.
 * @param {string} [options.privateKey] - OpenSSH private key contents.
 * @param {string} [options.privateKeyPath] - key file, read when `privateKey` is absent.
 * @param {string} [options.username] - SSH user.
 * @param {number} [options.timeoutMs] - handshake timeout.
 * @returns {Promise<{exec: Function, sftp: Function, end: Function}>} a session.
 */
export async function connectSsh({ port, privateKey, privateKeyPath, username = 'user', timeoutMs = 20000 }) {
  const key = privateKey || readFileSync(privateKeyPath, 'utf8')
  const client = new Client()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.end()
      reject(new Error(`SSH handshake to 127.0.0.1:${port} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    client
      .on('ready', () => {
        clearTimeout(timer)
        resolve()
      })
      .on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      .connect({ host: '127.0.0.1', port, username, privateKey: key, readyTimeout: timeoutMs })
  })

  return {
    raw: client,
    /**
     * Run one remote command.
     * @param {string} command - shell command.
     * @param {number} [timeout] - ceiling in ms.
     * @returns {Promise<{code: number, stdout: string, stderr: string}>} its result.
     */
    exec(command, timeout = 120000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`remote command timed out after ${timeout} ms: ${command.slice(0, 100)}`)), timeout)
        client.exec(command, (error, stream) => {
          if (error) {
            clearTimeout(timer)
            return reject(error)
          }
          let stdout = ''
          let stderr = ''
          stream.on('data', (chunk) => {
            stdout += chunk
          })
          stream.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          stream.on('close', (code) => {
            clearTimeout(timer)
            resolve({ code: code ?? 0, stdout, stderr })
          })
        })
      })
    },
    /** @returns {Promise<object>} an SFTP client on this connection. */
    sftp() {
      return new Promise((resolve, reject) => client.sftp((error, value) => (error ? reject(error) : resolve(value))))
    },
    /** Close the connection. */
    end() {
      try {
        client.end()
      } catch {
        // Already gone.
      }
    },
  }
}

/**
 * Ask whatever daemon of this bridge directory runs to stop, and wait until the
 * port is free so a fresh one can bind it.
 * @param {object} session - ssh session.
 * @param {string} base - bridge directory.
 * @param {number} remotePort - port the daemon listens on.
 * @returns {Promise<boolean>} whether something was running.
 */
async function stopDaemon(session, base, remotePort) {
  const probe = (command) =>
    command.replace('__PORT__', String(remotePort))
  const listening = async () => {
    const result = await session.exec(
      probe(
        `node -e "const n=require('net');const s=n.connect(__PORT__,'127.0.0.1');s.on('connect',()=>{console.log('UP');process.exit(0)});s.on('error',()=>{console.log('DOWN');process.exit(0)})" 2>/dev/null | tail -1`,
      ),
    )
    return result.stdout.trim() === 'UP'
  }
  const wasRunning = await listening()
  await session.exec(
    `if [ -f ${q(`${base}/bridge.pid`)} ]; then kill "$(cat ${q(`${base}/bridge.pid`)})" 2>/dev/null; fi; ` +
      `pkill -f ${q(daemonPattern(base))} 2>/dev/null; rm -f ${q(`${base}/bridge.pid`)}; ` +
      // A daemon started by an older version may not match the pattern: take the
      // port owner instead, which is always ours (loopback-only bridge port).
      `owner=$(ss -ltnp 2>/dev/null | grep ":${remotePort} " | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2); ` +
      `if [ -n "$owner" ]; then kill "$owner" 2>/dev/null; fi; true`,
  )
  const deadline = Date.now() + 15000
  while ((await listening()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 300))
  return wasRunning
}

/**
 * Resolve the bridge directory inside the dev space.
 * @param {object} session - ssh session.
 * @param {string} dir - configured directory (absolute or home-relative).
 * @returns {Promise<string>} the absolute directory.
 */
async function resolveDir(session, dir) {
  if (dir.startsWith('/')) return dir
  const home = (await session.exec('printf %s "$HOME"')).stdout.trim() || '/home/user'
  return `${home}/${dir}`
}

/**
 * Upload a text file in base64 chunks.
 * @param {object} session - ssh session.
 * @param {string} base - destination directory.
 * @param {string} name - file name.
 * @param {string} text - contents.
 * @returns {Promise<void>} resolves once the file is in place.
 */
async function uploadText(session, base, name, text) {
  const target = `${base}/${name}`
  const staging = `${target}.upload`
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  assertOk('truncate staging', await session.exec(`: > ${q(staging)}`))
  for (let offset = 0; offset < encoded.length; offset += UPLOAD_CHUNK) {
    const chunk = encoded.slice(offset, offset + UPLOAD_CHUNK)
    assertOk('append chunk', await session.exec(`printf %s ${q(chunk)} >> ${q(staging)}`))
  }
  const digest = createHash('sha256').update(text).digest('hex')
  const result = assertOk(
    'decode upload',
    await session.exec(
      `base64 -d ${q(staging)} > ${q(target)}.new && mv ${q(target)}.new ${q(target)} && rm -f ${q(staging)} && sha256sum ${q(target)} | cut -d' ' -f1`,
    ),
  )
  const remoteDigest = result.stdout.trim()
  if (remoteDigest !== digest) throw new Error(`bridge upload corrupted: ${remoteDigest} != ${digest}`)
}

/**
 * Ensure `ssh2` is available next to the bridge server.
 * @param {object} session - ssh session.
 * @param {string} base - bridge directory.
 * @param {boolean} install - whether npm install may be attempted.
 * @param {number} timeoutMs - ceiling for the install.
 * @returns {Promise<{installed: boolean, output: string}>} install outcome.
 */
async function ensureDependencies(session, base, install, timeoutMs) {
  const present = await session.exec(`test -d ${q(`${base}/node_modules/ssh2`)} && echo yes || echo no`)
  if (present.stdout.trim() === 'yes') return { installed: false, output: '' }
  if (!install) {
    throw new Error(`the dev space has no ssh2 for the SFTP bridge and installation is disabled (sftpBridgeInstall: false)`)
  }
  const npm = await session.exec(
    `cd ${q(base)} && (command -v npm || echo npm) && npm install --no-audit --no-fund --omit=optional --no-save ssh2@1 2>&1 | tail -5`,
    timeoutMs,
  )
  const ok = await session.exec(`test -d ${q(`${base}/node_modules/ssh2`)} && echo yes || echo no`)
  if (ok.stdout.trim() !== 'yes') {
    throw new Error(`npm install ssh2 failed in the dev space: ${(npm.stdout || npm.stderr).trim().slice(0, 300)}`)
  }
  return { installed: true, output: (npm.stdout || '').trim() }
}

/**
 * Start (or restart) the SFTP bridge inside a dev space.
 *
 * The dev space is reached through the ordinary dev-channel tunnel, so the
 * caller must have the dropbear endpoint up already.
 * @param {object} options - bridge options.
 * @param {number} options.tunnelPort - loopback port of the dropbear endpoint.
 * @param {string} [options.privateKey] - key contents (preferred).
 * @param {string} [options.privateKeyPath] - key path, used when contents are absent.
 * @param {string} [options.username] - SSH user.
 * @param {number} [options.remotePort] - port the bridge listens on, inside the dev space.
 * @param {string} [options.dir] - bridge directory, home-relative by default.
 * @param {boolean} [options.install] - allow npm install on first use.
 * @param {number} [options.timeoutMs] - ceiling for the first-time setup.
 * @param {(level: string, message: string) => void} [options.log] - diagnostics sink.
 * @returns {Promise<{dir: string, remotePort: number, pid: number, installed: boolean, version: string}>}
 */
export async function ensureBridge({
  tunnelPort,
  privateKey,
  privateKeyPath,
  username = 'user',
  remotePort = DEFAULT_BRIDGE_PORT,
  dir = DEFAULT_BRIDGE_DIR,
  install = true,
  timeoutMs = 300000,
  log = () => {},
}) {
  const session = await connectSsh({ port: tunnelPort, privateKey, privateKeyPath, username })
  try {
    const base = await resolveDir(session, dir)
    assertOk('mkdir bridge dir', await session.exec(`mkdir -p ${q(base)}`))

    const remoteSha = (await session.exec(`sha256sum ${q(`${base}/server.js`)} 2>/dev/null | cut -d' ' -f1`)).stdout.trim()
    if (remoteSha !== SERVER_SHA) {
      log('debug', `uploading the SFTP bridge server (${SERVER_SOURCE.length} bytes)`)
      await uploadText(session, base, 'server.js', SERVER_SOURCE)
    }

    const dependencies = await ensureDependencies(session, base, install, timeoutMs)

    if ((await session.exec(`test -f ${q(`${base}/host_key`)} && echo yes || echo no`)).stdout.trim() !== 'yes') {
      const hostKey = utils.generateKeyPairSync('ed25519')
      await uploadText(session, base, 'host_key', hostKey.private)
      assertOk('chmod host key', await session.exec(`chmod 600 ${q(`${base}/host_key`)}`))
    }

    const keyText = privateKey || readFileSync(privateKeyPath, 'utf8')
    const parsed = utils.parseKey(keyText)
    if (parsed instanceof Error) throw new Error(`cannot derive the public key for the bridge: ${parsed.message}`)
    const blob = parsed.getPublicSSH().toString('base64')

    // A previous connect may have left a daemon behind (a dropped tunnel cannot
    // be used to stop it), so always clear the port first.
    const replaced = await stopDaemon(session, base, remotePort)
    const script = `${base}/server.js`
    assertOk(
      'start bridge',
      await session.exec(
        `cd ${q(base)} && setsid nohup node ${q(script)} --port ${remotePort} --host-key ${q(`${base}/host_key`)} ` +
          `--pid-file ${q(`${base}/bridge.pid`)} --authorized-key ${q(blob)} >> ${q(`${base}/bridge.log`)} 2>&1 < /dev/null & ` +
          `sleep 1; cat ${q(`${base}/bridge.pid`)} 2>/dev/null || true`,
      ),
    )

    // The daemon is detached: give it a moment to bind, then confirm it is up.
    let listening = false
    const deadline = Date.now() + 20000
    while (!listening && Date.now() < deadline) {
      const probe = await session.exec(
        `node -e "const n=require('net');const s=n.connect(${remotePort},'127.0.0.1');s.on('connect',()=>{console.log('UP');process.exit(0)});s.on('error',()=>{console.log('DOWN');process.exit(0)})" 2>/dev/null | tail -1`,
      )
      listening = probe.stdout.trim() === 'UP'
      if (!listening) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!listening) {
      const tail = (await session.exec(`tail -8 ${q(`${base}/bridge.log`)} 2>/dev/null`)).stdout.trim()
      throw new Error(`the SFTP bridge did not start listening on ${remotePort}${tail ? `:\n${tail}` : ''}`)
    }

    const pid = Number((await session.exec(`cat ${q(`${base}/bridge.pid`)} 2>/dev/null`)).stdout.trim()) || 0
    if (replaced) log('debug', `replaced a previous SFTP bridge daemon on port ${remotePort}`)
    if (dependencies.installed) log('info', `installed ssh2 in the dev space (${dependencies.output.split('\n').pop() || ''})`.trim())
    log('debug', `SFTP bridge listening inside the dev space on 127.0.0.1:${remotePort} (pid ${pid})`)
    return { dir: base, remotePort, pid, installed: dependencies.installed, version: SERVER_SHA.slice(0, 12) }
  } finally {
    session.end()
  }
}

/**
 * Stop the bridge daemon of a dev space.
 * @param {object} options - stop options.
 * @param {number} options.tunnelPort - loopback port of the dropbear endpoint.
 * @param {string} [options.privateKey] - key contents.
 * @param {string} [options.privateKeyPath] - key path.
 * @param {string} [options.username] - SSH user.
 * @param {string} [options.dir] - bridge directory.
 * @returns {Promise<boolean>} whether a daemon was asked to stop.
 */
export async function stopBridge({ tunnelPort, privateKey, privateKeyPath, username = 'user', dir = DEFAULT_BRIDGE_DIR, remotePort = DEFAULT_BRIDGE_PORT }) {
  const session = await connectSsh({ port: tunnelPort, privateKey, privateKeyPath, username, timeoutMs: 10000 })
  try {
    const base = await resolveDir(session, dir)
    return await stopDaemon(session, base, remotePort)
  } finally {
    session.end()
  }
}

/**
 * Report the bridge state of a dev space (used by `bas_status`).
 * @param {object} options - query options.
 * @param {number} options.tunnelPort - loopback port of the dropbear endpoint.
 * @param {string} [options.privateKey] - key contents.
 * @param {string} [options.privateKeyPath] - key path.
 * @param {string} [options.username] - SSH user.
 * @param {string} [options.dir] - bridge directory.
 * @param {number} [options.remotePort] - port the bridge should listen on.
 * @returns {Promise<{installed: boolean, running: boolean, pid: number, logTail: string}>} bridge state.
 */
export async function bridgeState({ tunnelPort, privateKey, privateKeyPath, username = 'user', dir = DEFAULT_BRIDGE_DIR, remotePort = DEFAULT_BRIDGE_PORT }) {
  const session = await connectSsh({ port: tunnelPort, privateKey, privateKeyPath, username, timeoutMs: 10000 })
  try {
    const base = await resolveDir(session, dir)
    const probe = await session.exec(
      `test -d ${q(`${base}/node_modules/ssh2`)} && echo installed || echo missing; ` +
        `if [ -f ${q(`${base}/bridge.pid`)} ] && kill -0 "$(cat ${q(`${base}/bridge.pid`)})" 2>/dev/null; then echo running; cat ${q(`${base}/bridge.pid`)}; else echo stopped; fi; ` +
        `(ss -ltn 2>/dev/null | grep -c ":${remotePort} " || true)`,
    )
    const lines = probe.stdout.trim().split('\n')
    return {
      installed: lines[0] === 'installed',
      running: lines[1] === 'running',
      pid: Number(lines[2]) || 0,
      listening: Number(lines[3]) > 0,
      dir: base,
      logTail: (await session.exec(`tail -5 ${q(`${base}/bridge.log`)} 2>/dev/null`)).stdout.trim(),
    }
  } finally {
    session.end()
  }
}

export { SERVER_SHA }
