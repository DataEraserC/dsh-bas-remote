// Regression test for the SFTP bridge server (lib/bridge-server.cjs).
//
// The bridge is a small SSH server: it must refuse every key except the one the
// landscape handed out, and it must serve the exec + SFTP surface the remote
// tools use. Run it with `npm test` (needs the `ssh2` dependency).
//
// It starts the real server against a scratch directory, talks to it with a real
// ssh2 client, and asserts behaviour — no mocks, no dev space required.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'

const { Client, utils } = ssh2
const here = dirname(fileURLToPath(import.meta.url))
const SERVER = join(here, '..', 'lib', 'bridge-server.cjs')

/** @param {object} options - test options. @returns {Promise<object>} client helpers. */
function connect({ port, privateKey }) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client
      .on('ready', () => {
        const sftp = () =>
          new Promise((resolveSftp, rejectSftp) => client.sftp((error, value) => (error ? rejectSftp(error) : resolveSftp(value))))
        resolve({
          client,
          exec: (command) =>
            new Promise((resolveExec, rejectExec) =>
              client.exec(command, (error, stream) => {
                if (error) return rejectExec(error)
                let output = ''
                stream.on('data', (chunk) => {
                  output += chunk
                })
                stream.on('close', (code) => resolveExec({ code, output }))
              }),
            ),
          sftp,
        })
      })
      .on('error', reject)
      .connect({ host: '127.0.0.1', port, username: 'user', privateKey, readyTimeout: 10000 })
  })
}

/** @param {object} sftp - ssh2 SFTP client. @param {string} method - call. @param {...any} args - arguments. */
function call(sftp, method, ...args) {
  return new Promise((resolve, reject) => sftp[method](...args, (error, value) => (error ? reject(error) : resolve(value))))
}

const root = mkdtempSync(join(tmpdir(), 'dsh-bas-bridge-test-'))
const workspace = join(root, 'workspace')
mkdirSync(workspace)
writeFileSync(join(workspace, 'hello.txt'), 'hello bridge\n')

const hostKey = utils.generateKeyPairSync('ed25519')
writeFileSync(join(root, 'host_key'), hostKey.private, { mode: 0o600 })
const clientKey = utils.generateKeyPairSync('ed25519')
const blob = utils.parseKey(clientKey.public).getPublicSSH().toString('base64')

const port = 25611
const server = spawn(process.execPath, [
  SERVER,
  '--port', String(port),
  '--host-key', join(root, 'host_key'),
  '--pid-file', join(root, 'bridge.pid'),
  '--authorized-key', blob,
])
let serverLog = ''
server.stdout.on('data', (chunk) => {
  serverLog += chunk
})
server.stderr.on('data', (chunk) => {
  serverLog += chunk
})

const checks = []
/** @param {string} name - check name. @param {() => Promise<void>} body - assertions. */
async function check(name, body) {
  try {
    await body()
    checks.push(`ok   ${name}`)
  } catch (error) {
    checks.push(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

try {
  const deadline = Date.now() + 10000
  while (!/listening on/.test(serverLog) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.match(serverLog, /listening on/, `server did not start:\n${serverLog}`)

  await check('refuses a key that is not the authorized one', async () => {
    const stranger = utils.generateKeyPairSync('ed25519')
    const outcome = await connect({ port, privateKey: stranger.private }).then(
      () => 'connected',
      (error) => error.level || error.message,
    )
    assert.equal(outcome, 'client-authentication')
  })

  const session = await connect({ port, privateKey: clientKey.private })
  const sftp = await session.sftp()

  await check('runs commands over exec', async () => {
    const result = await session.exec('echo EXEC_OK; whoami')
    assert.match(result.output, /EXEC_OK/)
    assert.equal(result.code, 0)
  })

  await check('stats a directory (the check that failed on dropbear)', async () => {
    const stats = await call(sftp, 'stat', workspace)
    assert.equal(stats.isDirectory(), true)
  })

  await check('reports timestamps in seconds, not milliseconds', async () => {
    const stats = await call(sftp, 'stat', join(workspace, 'hello.txt'))
    assert.ok(Math.abs(stats.mtime * 1000 - Date.now()) < 600000, `mtime ${stats.mtime} is not recent`)
  })

  await check('lists a directory and reads a file', async () => {
    const entries = await call(sftp, 'readdir', workspace)
    assert.ok(entries.some((entry) => entry.filename === 'hello.txt' && !entry.attrs.isDirectory()))
    assert.equal(String(await call(sftp, 'readFile', join(workspace, 'hello.txt'))), 'hello bridge\n')
  })

  await check('writes, renames, removes and creates directories', async () => {
    await call(sftp, 'writeFile', join(workspace, 'written.txt'), 'written by sftp\n')
    assert.equal(readFileSync(join(workspace, 'written.txt'), 'utf8'), 'written by sftp\n')
    await call(sftp, 'mkdir', join(workspace, 'sub'), { mode: 0o755 })
    await call(sftp, 'rename', join(workspace, 'written.txt'), join(workspace, 'sub', 'moved.txt'))
    assert.equal(readFileSync(join(workspace, 'sub', 'moved.txt'), 'utf8'), 'written by sftp\n')
    await call(sftp, 'unlink', join(workspace, 'sub', 'moved.txt'))
    await call(sftp, 'rmdir', join(workspace, 'sub'))
  })

  await check('transfers a large file both ways (fastPut / fastGet)', async () => {
    const source = join(root, 'upload.bin')
    writeFileSync(source, Buffer.alloc(300000, 7))
    await call(sftp, 'fastPut', source, join(workspace, 'upload.bin'))
    const target = join(root, 'download.bin')
    await call(sftp, 'fastGet', join(workspace, 'upload.bin'), target)
    assert.ok(readFileSync(target).equals(readFileSync(source)))
  })

  await check('creates and follows symlinks', async () => {
    const link = join(workspace, 'link.txt')
    await call(sftp, 'symlink', join(workspace, 'hello.txt'), link)
    assert.equal(String(await call(sftp, 'readlink', link)), join(workspace, 'hello.txt'))
    assert.equal((await call(sftp, 'lstat', link)).isSymbolicLink(), true)
  })

  await check('reports a missing path as NO_SUCH_FILE', async () => {
    const failure = await call(sftp, 'stat', join(workspace, 'nope')).then(
      () => 'resolved',
      (error) => error.code,
    )
    assert.equal(failure, 2)
  })

  await check('resolves a path with realpath', async () => {
    assert.equal(await call(sftp, 'realpath', workspace), workspace)
  })

  session.client.end()
} finally {
  server.kill()
}

console.log(checks.join('\n'))
console.log(process.exitCode ? '\nSFTP bridge: FAILED' : `\nSFTP bridge: ${checks.length} checks passed`)
