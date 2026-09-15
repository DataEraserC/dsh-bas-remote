// Live end-to-end check against a real BAS dev space.
//
// It drives the real plugin (`lib/index.js`) with a stubbed cordis context and a
// stored credential, connects a dev space with the SFTP bridge enabled, and then
// exercises — through the endpoint the plugin reports — the SFTP operations the
// remote tools use, including the `stat("/home/user")` that fails on dropbear.
//
// It needs a signed-in landscape, so it is not part of `npm test`:
//
//   BAS_LANDSCAPE=https://<tenant>.applicationstudio.cloud.sap \
//   BAS_DEVSPACE=<dev space id or label> \
//   BAS_JWT=<token>            # optional: defaults to ~/.dsh/.credentials.yaml
//   node test/live-devspace.mjs
//
// Nothing is written outside a scratch DSH_HOME and the dev space's own
// ~/.dsh-bas-remote/sftp-bridge directory (which is the feature under test).

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js'))
const { Client, utils } = require('ssh2')
const LANDSCAPE = process.env.BAS_LANDSCAPE
const DEVSPACE = process.env.BAS_DEVSPACE
if (!LANDSCAPE || !DEVSPACE) {
  console.error('set BAS_LANDSCAPE and BAS_DEVSPACE (see the header of this file)')
  process.exit(2)
}
const jwt =
  process.env.BAS_JWT ||
  /jwt:\s*(\S+)/.exec(readFileSync(join(process.env.HOME, '.dsh', '.credentials.yaml'), 'utf8'))[1]
const HOME_DIR = mkdtempSync(join(tmpdir(), 'dsh-bas-e2e-'))
process.env.DSH_HOME = HOME_DIR

const tools = []
const ctx = {
  tools: { register: (tool) => tools.push(tool) },
  commands: { register: () => {} },
  credentials: {
    readRecord: async () => ({ kind: 'grant', payload: { landscape: LANDSCAPE, jwt, obtainedAt: Date.now() } }),
    modifyRecord: async () => {},
    deleteRecord: async () => {},
  },
  systemPrompt: { section: () => {} },
  effect: () => {},
  inject: () => {},
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}
const mod = await import('../lib/index.js')
// Schemastery has no `.resolve`, so spell the defaults out (as cordis would).
const config = {
  loginHost: '127.0.0.1', loginPort: 55532, loginTimeoutMs: 180000, devSpaceTimeoutMs: 240000,
  sshConfigPath: '', sshDir: join(HOME_DIR, 'ssh'), sshUser: 'user', sshConfigMode: 'off',
  sshConfigFragmentPath: '', manageSshConfig: false, removeKeyOnDisconnect: false, localPort: 0,
  sftpBridge: true, sftpBridgePort: 2223, sftpBridgeDir: '.dsh-bas-remote/sftp-bridge',
  sftpBridgeInstall: true, sftpBridgeTimeoutMs: 300000, promptSection: true, connectAttempts: 3,
  defaultLandscape: LANDSCAPE, debug: true,
}
mod.apply(ctx, config)

const find = (name) => tools.find((tool) => tool.name === name)
const connect = find('bas_connect')
if (!connect) throw new Error('bas_connect not registered: ' + tools.map((t) => t.name).join(','))

console.log('=== bas_connect (bridge enabled) ===')
const started = Date.now()
const result = await connect.execute({ devSpace: DEVSPACE, landscape: LANDSCAPE })
console.log(result.text)
console.log(`(setup took ${Math.round((Date.now() - started) / 1000)}s)`)

const bridgePort = Number(/SFTP: 127\.0\.0\.1:(\d+)/.exec(result.text)?.[1] ?? /port=(\d+)/.exec(result.text)?.[1])
const keyFile = /privateKeyPath=(\S+)/.exec(result.text)[1]
const keyText = readFileSync(keyFile, 'utf8')
console.log(`\nbridge port=${bridgePort} key=${keyFile}`)

const ssh = (port) => new Promise((resolve, reject) => {
  const client = new Client()
  client.on('ready', () => resolve(client)).on('error', reject)
    .connect({ host: '127.0.0.1', port, username: 'user', privateKey: keyText, readyTimeout: 15000 })
})
const call = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, value) => (error ? reject(error) : resolve(value))))
const ok = (label, value) => console.log(`${value ? 'PASS' : 'FAIL'} ${label}`)

console.log('\n=== what the user could not do: SFTP over the reported endpoint ===')
const client = await ssh(bridgePort)
const sftp = await new Promise((resolve, reject) => client.sftp((error, value) => (error ? reject(error) : resolve(value))))
const home = await call(sftp, 'stat', '/home/user')
ok('stat("/home/user") is a directory (was "not a directory (or unreachable)")', home.isDirectory() === true)
const projects = await call(sftp, 'readdir', '/home/user/projects')
ok('readdir("/home/user/projects") returns entries', Array.isArray(projects) && projects.length > 0)
const probe = `/home/user/projects/.dsh-bridge-e2e-${Date.now()}.txt`
await call(sftp, 'writeFile', probe, 'written through the bridge\n')
ok('writeFile() through dsh-remote-style SFTP works', String(await call(sftp, 'readFile', probe)) === 'written through the bridge\n')
await call(sftp, 'unlink', probe)
const execOutput = await new Promise((resolve, reject) => client.exec('echo exec-over-bridge; whoami', (error, stream) => {
  if (error) return reject(error)
  let out = ''
  stream.on('data', (chunk) => { out += chunk })
  stream.on('close', () => resolve(out.trim()))
}))
ok(`exec also works on the same endpoint (${execOutput.replace(/\n/g, ' | ')})`, /exec-over-bridge/.test(execOutput))
// rw_push / rw_sync semantics: fastPut + fastGet + tree operations.
const localSrc = join(HOME_DIR, 'upload.bin')
writeFileSync(localSrc, Buffer.alloc(250000, 3))
const remoteDir = '/home/user/projects/dsh-bridge-check-' + Date.now()
await call(sftp, 'mkdir', remoteDir, { mode: 0o755 })
await call(sftp, 'fastPut', localSrc, remoteDir + '/upload.bin')
const localDst = join(HOME_DIR, 'download.bin')
await call(sftp, 'fastGet', remoteDir + '/upload.bin', localDst)
ok('fastPut/fastGet through the dev-space bridge round-trip 250 KB', readFileSync(localDst).equals(readFileSync(localSrc)))
await call(sftp, 'rename', remoteDir + '/upload.bin', remoteDir + '/moved.bin')
ok('rename() works in the dev space', (await call(sftp, 'readdir', remoteDir)).some((e) => e.filename === 'moved.bin'))
await call(sftp, 'unlink', remoteDir + '/moved.bin')
await call(sftp, 'rmdir', remoteDir)
ok('unlink() + rmdir() clean up', (await call(sftp, 'stat', remoteDir).then(() => false).catch(() => true)))
await new Promise((resolve, reject) => client.exec('rm -rf /home/user/projects/dsh-bridge-check-* /home/user/projects/.dsh-bridge-e2e-*.txt 2>/dev/null; true', (error, stream) => {
  if (error) return reject(error)
  stream.on('close', resolve)
  stream.resume()
}))
client.end()

console.log('\n=== bas_bridge status ===')
console.log((await find('bas_bridge').execute({ devSpace: DEVSPACE })).text)

console.log('\n=== bas_status ===')
console.log((await find('bas_status').execute({})).text)

console.log('\n=== bas_disconnect (must stop the bridge) ===')
console.log((await find('bas_disconnect').execute({ devSpace: DEVSPACE })).text)
const check = await ssh(bridgePort).then(() => true).catch(() => false)
ok('the bridge endpoint is closed after disconnect', check === false)
process.exit(0)
