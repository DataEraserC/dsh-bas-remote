'use strict'

// dsh-bas-remote — SFTP bridge server.
//
// This file does NOT run in the harness. It is uploaded into a BAS dev space and
// started there by `lib/bridge.js`, because the dev space's own sshd is dropbear
// and the image ships no `sftp-server` (`/usr/lib/sftp-server` is missing, the
// image has no root and `/usr/lib` is read-only), so SFTP over the dev channel
// fails with exit code 127. Everything that speaks SFTP — `rw_stat`,
// `rw_read_file`, `rw_write_file`, `rw_sync`, `rw_push`, dsh-remote's
// mirror/pick — therefore cannot work against dropbear.
//
// This server is a small SSH server with the same exec + SFTP surface those
// tools need, listening on the dev space's loopback (never on an external
// interface; it is only reachable through the dev-channel port forward) and
// authenticating exactly one public key: the one the landscape handed out.
//
// It is intentionally plain CommonJS and dependency-free apart from `ssh2`,
// which is installed next to it inside the dev space.
//
// Usage:
//   node server.js --port 2223 --host-key ./host_key --authorized-key <base64 blob>

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { Server, utils } = require('ssh2')

const { OPEN_MODE, STATUS_CODE } = utils.sftp

/** @param {string} name - flag name. @param {string} fallback - default value. */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || process.argv[index + 1] === undefined) return fallback
  return process.argv[index + 1]
}

const port = Number(arg('port', '0'))
const hostKeyPath = arg('host-key', path.join(__dirname, 'host_key'))
const pidFile = arg('pid-file', '')
const authorizedKeys = String(arg('authorized-key', ''))
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const shellPath = process.env.SHELL || '/bin/bash'
const homeDir = process.env.HOME || '/home/user'
const idleTimeoutMs = Number(arg('idle-timeout', '0')) || 0

if (!port) {
  process.stderr.write('sftp-bridge: --port is required\n')
  process.exit(2)
}
if (authorizedKeys.length === 0) {
  process.stderr.write('sftp-bridge: --authorized-key is required\n')
  process.exit(2)
}

/** @param {string} message - log line. */
function log(message) {
  process.stdout.write(`[sftp-bridge ${new Date().toISOString()}] ${message}\n`)
}

// ── SFTP helpers ────────────────────────────────────────────────────────────

/** POSIX type bits for a stat result (already part of `mode` on Linux). */
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

/**
 * Convert a `fs.Stats` into SFTP attrs.
 *
 * The protocol carries seconds since the epoch, so the millisecond fields are
 * divided down: sending milliseconds makes every timestamp land in the year
 * 50000 for clients that multiply by 1000.
 * @param {import('fs').Stats} stats - stat result.
 * @returns {object} SFTP attrs.
 */
function attrsFromStats(stats) {
  let mode = stats.mode
  if (!(mode & 0o170000)) {
    mode |= stats.isDirectory() ? S_IFDIR : stats.isSymbolicLink() ? S_IFLNK : S_IFREG
  }
  return {
    mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  }
}

/** @param {object} attrs - SFTP attrs. @returns {string} an `ls -l` style line. */
function longName(attrs, filename) {
  const type = (attrs.mode & 0o170000) === S_IFDIR ? 'd' : (attrs.mode & 0o170000) === S_IFLNK ? 'l' : '-'
  const bits = 'rwxrwxrwx'
  let permissions = ''
  for (let bit = 0; bit < 9; bit += 1) {
    permissions += attrs.mode & (0o400 >> bit) ? bits[bit] : '-'
  }
  const when = new Date((attrs.mtime || 0) * 1000).toISOString().slice(0, 16).replace('T', ' ')
  return `${type}${permissions} 1 ${attrs.uid ?? 0} ${attrs.gid ?? 0} ${attrs.size ?? 0} ${when} ${filename}`
}

/**
 * Map SFTP open flags onto `fs.open` flags.
 * @param {number} flags - SFTP OPEN_MODE bits.
 * @returns {string} an `fs.open` flag string.
 */
function openFlags(flags) {
  const read = Boolean(flags & OPEN_MODE.READ)
  const write = Boolean(flags & OPEN_MODE.WRITE)
  const create = Boolean(flags & OPEN_MODE.CREAT)
  const truncate = Boolean(flags & OPEN_MODE.TRUNC)
  const append = Boolean(flags & OPEN_MODE.APPEND)
  const exclusive = Boolean(flags & OPEN_MODE.EXCL)
  if (append) return read && write ? 'a+' : 'a'
  if (read && write) return create && exclusive ? 'wx+' : create && truncate ? 'w+' : 'r+'
  if (write) return create && exclusive ? 'wx' : create && truncate ? 'w' : 'r+'
  return 'r'
}

/**
 * Translate a Node error into an SFTP status code.
 * @param {NodeJS.ErrnoException} error - thrown error.
 * @returns {number} SFTP status code.
 */
function statusFromError(error) {
  switch (error && error.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return STATUS_CODE.NO_SUCH_FILE
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return STATUS_CODE.PERMISSION_DENIED
    default:
      return STATUS_CODE.FAILURE
  }
}

/** Apply SFTP attrs to a path, ignoring the fields the client left unset. */
function setAttrs(target, attrs, done) {
  const tasks = []
  if (typeof attrs.mode === 'number') tasks.push((next) => fs.chmod(target, attrs.mode & 0o7777, next))
  if (typeof attrs.uid === 'number' || typeof attrs.gid === 'number') {
    tasks.push((next) => fs.chown(target, attrs.uid ?? -1, attrs.gid ?? -1, next))
  }
  if (typeof attrs.atime === 'number' || typeof attrs.mtime === 'number') {
    tasks.push((next) => fs.utimes(target, attrs.atime ?? attrs.mtime ?? 0, attrs.mtime ?? attrs.atime ?? 0, next))
  }
  let index = 0
  const step = (error) => {
    if (error) return done(error)
    if (index >= tasks.length) return done(null)
    tasks[index++](step)
  }
  step(null)
}

// ── Server ──────────────────────────────────────────────────────────────────

let clientCount = 0

const server = new Server({ hostKeys: [fs.readFileSync(hostKeyPath)], ident: 'dsh-bas-remote-sftp-bridge' }, (client) => {
  clientCount += 1
  log(`client connected (${clientCount} active)`)

  client.on('authentication', (ctx) => {
    if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
    const presented = ctx.key && ctx.key.data ? ctx.key.data.toString('base64') : ''
    if (!authorizedKeys.includes(presented)) {
      log(`rejected public key for ${ctx.username}`)
      return ctx.reject(['publickey'])
    }
    // Accepting without a signature lets the client sign and come back.
    return ctx.accept()
  })

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()

      session.on('pty', (acceptPty) => acceptPty && acceptPty())
      session.on('window-change', (acceptChange) => acceptChange && acceptChange())
      session.on('env', (acceptEnv) => acceptEnv && acceptEnv())

      const startProcess = (stream, command, env) => {
        const child = spawn(shellPath, ['-c', command], {
          cwd: homeDir,
          env: Object.assign({}, process.env, env || {}, { TERM: process.env.TERM || 'xterm-256color' }),
        })
        let exited = false
        const finish = (code, signal) => {
          if (exited) return
          exited = true
          try {
            stream.exit(signal ? 128 : code ?? 0)
            stream.end()
          } catch {
            // The channel may already be gone.
          }
        }
        child.stdout.on('data', (chunk) => stream.write(chunk))
        child.stderr.on('data', (chunk) => stream.write(chunk))
        child.on('error', (error) => {
          stream.write(`dsh-bas-remote: cannot run ${shellPath}: ${error.message}\n`)
          finish(127, null)
        })
        child.on('exit', finish)
        stream.on('close', () => {
          if (!exited) child.kill('SIGHUP')
        })
        return child
      }

      session.on('exec', (acceptExec, rejectExec, info) => {
        const stream = acceptExec()
        const command = info && info.command ? info.command : 'true'
        log(`exec: ${command.slice(0, 120)}`)
        startProcess(stream, command, info && info.env)
      })

      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        log('interactive shell')
        startProcess(stream, `exec ${shellPath} -i`, {})
      })

      session.on('sftp', (acceptSftp) => {
        const sftpStream = acceptSftp()
        log('sftp session')

        /** @type {Map<number, {kind: 'file', fd: number} | {kind: 'dir', entries: object[]}>} */
        const handles = new Map()
        let handleSeq = 1

        const makeHandle = (entry) => {
          const handle = Buffer.alloc(4)
          handle.writeUInt32BE(handleSeq, 0)
          handles.set(handleSeq, entry)
          handleSeq += 1
          return handle
        }
        const getHandle = (handle) => {
          if (!Buffer.isBuffer(handle) || handle.length !== 4) return null
          return handles.get(handle.readUInt32BE(0)) || null
        }
        const fail = (reqid, error) => sftpStream.status(reqid, statusFromError(error))

        sftpStream.on('OPEN', (reqid, filename, flags, attrs) => {
          fs.open(filename, openFlags(flags), attrs && typeof attrs.mode === 'number' ? attrs.mode & 0o7777 : 0o666, (error, fd) => {
            if (error) return fail(reqid, error)
            sftpStream.handle(reqid, makeHandle({ kind: 'file', fd }))
          })
        })

        sftpStream.on('READ', (reqid, handle, offset, length) => {
          const entry = getHandle(handle)
          if (!entry || entry.kind !== 'file') return sftpStream.status(reqid, STATUS_CODE.FAILURE)
          const buffer = Buffer.alloc(length)
          fs.read(entry.fd, buffer, 0, length, offset, (error, bytesRead) => {
            if (error) return fail(reqid, error)
            if (bytesRead === 0) return sftpStream.status(reqid, STATUS_CODE.EOF)
            sftpStream.data(reqid, buffer.subarray(0, bytesRead))
          })
        })

        sftpStream.on('WRITE', (reqid, handle, offset, data) => {
          const entry = getHandle(handle)
          if (!entry || entry.kind !== 'file') return sftpStream.status(reqid, STATUS_CODE.FAILURE)
          fs.write(entry.fd, data, 0, data.length, offset, (error) => {
            if (error) return fail(reqid, error)
            sftpStream.status(reqid, STATUS_CODE.OK)
          })
        })

        sftpStream.on('CLOSE', (reqid, handle) => {
          const entry = getHandle(handle)
          if (!entry) return sftpStream.status(reqid, STATUS_CODE.FAILURE)
          handles.delete(handle.readUInt32BE(0))
          if (entry.kind !== 'file') return sftpStream.status(reqid, STATUS_CODE.OK)
          fs.close(entry.fd, (error) => (error ? fail(reqid, error) : sftpStream.status(reqid, STATUS_CODE.OK)))
        })

        const replyStats = (reqid, filename, statsFn) => {
          statsFn(filename, (error, stats) => {
            if (error) return fail(reqid, error)
            sftpStream.attrs(reqid, attrsFromStats(stats))
          })
        }

        sftpStream.on('STAT', (reqid, filename) => replyStats(reqid, filename, fs.stat))
        sftpStream.on('LSTAT', (reqid, filename) => replyStats(reqid, filename, fs.lstat))

        sftpStream.on('FSTAT', (reqid, handle) => {
          const entry = getHandle(handle)
          if (!entry || entry.kind !== 'file') return sftpStream.status(reqid, STATUS_CODE.FAILURE)
          fs.fstat(entry.fd, (error, stats) => {
            if (error) return fail(reqid, error)
            sftpStream.attrs(reqid, attrsFromStats(stats))
          })
        })

        sftpStream.on('SETSTAT', (reqid, filename, attrs) => {
          setAttrs(filename, attrs || {}, (error) => (error ? fail(reqid, error) : sftpStream.status(reqid, STATUS_CODE.OK)))
        })

        sftpStream.on('FSETSTAT', (reqid, handle, attrs) => {
          const entry = getHandle(handle)
          if (!entry || entry.kind !== 'file') return sftpStream.status(reqid, STATUS_CODE.FAILURE)
          setAttrs(`/proc/self/fd/${entry.fd}`, attrs || {}, (error) =>
            error ? fail(reqid, error) : sftpStream.status(reqid, STATUS_CODE.OK),
          )
        })

        sftpStream.on('OPENDIR', (reqid, filename) => {
          fs.readdir(filename, { withFileTypes: true }, (error, dirents) => {
            if (error) return fail(reqid, error)
            const entries = []
            for (const dirent of dirents) {
              const full = path.join(filename, dirent.name)
              let attrs = { mode: dirent.isDirectory() ? S_IFDIR | 0o755 : S_IFREG | 0o644, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 }
              try {
                attrs = attrsFromStats(fs.lstatSync(full))
              } catch {
                // A vanishing entry keeps the synthetic attrs above.
              }
              entries.push({ filename: dirent.name, longname: longName(attrs, dirent.name), attrs })
            }
            sftpStream.handle(reqid, makeHandle({ kind: 'dir', entries }))
          })
        })

        sftpStream.on('READDIR', (reqid, handle) => {
          const entry = getHandle(handle)
          if (!entry) return sftpStream.status(reqid, STATUS_CODE.FAILURE)
          if (entry.kind !== 'dir' || entry.sent) return sftpStream.status(reqid, STATUS_CODE.EOF)
          entry.sent = true
          sftpStream.name(reqid, entry.entries)
        })

        sftpStream.on('REMOVE', (reqid, filename) => {
          fs.unlink(filename, (error) => (error ? fail(reqid, error) : sftpStream.status(reqid, STATUS_CODE.OK)))
        })

        sftpStream.on('MKDIR', (reqid, filename, attrs) => {
          fs.mkdir(filename, { mode: attrs && typeof attrs.mode === 'number' ? attrs.mode & 0o7777 : 0o755 }, (error) =>
            error ? fail(reqid, error) : sftpStream.status(reqid, STATUS_CODE.OK),
          )
        })

        sftpStream.on('RMDIR', (reqid, filename) => {
          fs.rmdir(filename, (error) => (error ? fail(reqid, error) : sftpStream.status(reqid, STATUS_CODE.OK)))
        })

        sftpStream.on('RENAME', (reqid, oldPath, newPath) => {
          fs.rename(oldPath, newPath, (error) => (error ? fail(reqid, error) : sftpStream.status(reqid, STATUS_CODE.OK)))
        })

        sftpStream.on('READLINK', (reqid, filename) => {
          fs.readlink(filename, (error, target) => {
            if (error) return fail(reqid, error)
            sftpStream.name(reqid, [{ filename: target, longname: target, attrs: {} }])
          })
        })

        sftpStream.on('SYMLINK', (reqid, first, second) => {
          // ssh2 emits (linkPath, targetPath) for peers that are not OpenSSH and
          // (targetPath, linkPath) for OpenSSH ones; the wire order differs.
          const isOpenSshPeer = Boolean(sftpStream._isOpenSSH)
          const linkPath = isOpenSshPeer ? second : first
          const targetPath = isOpenSshPeer ? first : second
          fs.symlink(targetPath, linkPath, (error) => (error ? fail(reqid, error) : sftpStream.status(reqid, STATUS_CODE.OK)))
        })

        sftpStream.on('REALPATH', (reqid, filename) => {
          const resolve = (resolved) => {
            let attrs = {}
            try {
              attrs = attrsFromStats(fs.statSync(resolved))
            } catch {
              // REALPATH must answer for paths that do not exist yet.
            }
            sftpStream.name(reqid, [{ filename: resolved, longname: resolved, attrs }])
          }
          fs.realpath(filename, (error, resolved) => resolve(error ? path.resolve(filename) : resolved))
        })
      })
    })
  })

  client.on('close', () => {
    clientCount -= 1
    log(`client disconnected (${clientCount} active)`)
  })

  // A client that vanishes (a killed harness, a dropped tunnel) makes ssh2's
  // keepalive fail and emit 'error' here; an unhandled 'error' event would kill
  // the whole daemon, so it is always handled.
  client.on('error', (error) => {
    log(`client error (${error.level || 'error'}): ${error.message}`)
  })
})

server.on('error', (error) => {
  log(`server error: ${error.message}`)
  process.exit(1)
})

// Last-resort net: the bridge is a long-lived daemon that must not die because
// one request failed.
process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error && error.stack ? error.stack.split('\n')[0] : String(error)}`)
})
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
})

if (idleTimeoutMs > 0) {
  let lastActivity = Date.now()
  server.on('connection', () => {
    lastActivity = Date.now()
  })
  setInterval(() => {
    if (Date.now() - lastActivity > idleTimeoutMs && clientCount === 0) {
      log('idle timeout, exiting')
      process.exit(0)
    }
  }, Math.min(idleTimeoutMs, 60000)).unref()
}

server.listen(port, '127.0.0.1', function onListen() {
  // Write our own pid: `setsid nohup node …` makes `$!` the wrapper, not node.
  if (pidFile) {
    try {
      fs.writeFileSync(pidFile, `${process.pid}\n`)
    } catch (error) {
      log(`cannot write ${pidFile}: ${error.message}`)
    }
  }
  log(`listening on 127.0.0.1:${this.address().port} as ${process.env.USER || 'user'} (home ${homeDir}) pid ${process.pid}`)
})
