// Tests for the client half (lib/client.js).
//
// The client is a classic script for the harness module loader: it calls
// `window.__ModuleLoader__.load({ factory })` and builds plain React element
// trees. That makes it testable without a DOM — this file stubs `react` and the
// slot registry, renders the components, and inspects the returned trees.
//
// Run with `npm test`.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** A minimal `react` stub: element trees plus the hooks the client uses. */
function createReactStub(hookValues) {
  const queue = [...hookValues]
  const refs = []
  return {
    createElement(type, props, ...children) {
      const resolved = { ...(props || {}) }
      const flat = children.flat().filter((child) => child !== null && child !== undefined && child !== false)
      if (flat.length) resolved.children = flat
      return { type, props: resolved }
    },
    useState(initial) {
      const value = queue.length ? queue.shift() : initial
      return [value, () => {}]
    },
    useRef(initial) {
      const ref = { current: initial }
      refs.push(ref)
      return ref
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    Fragment: 'Fragment',
    __refs: refs,
  }
}

/**
 * Load lib/client.js with stubs and return what it registered.
 * @param {object} options - loader options.
 * @param {*} options.state - value the first `useState` returns (the polled snapshot).
 * @param {*} [options.open] - value the second `useState` returns (panel open flag).
 * @returns {{registrations: object[], react: object}} registrations and the react stub.
 */
function loadClient({ state, open = false } = {}) {
  const react = createReactStub([state, open])
  const registrations = []
  const slots = {
    inject(_name, factory) {
      factory()
    },
    register(meta, component) {
      registrations.push({ meta, component })
      return () => {}
    },
  }
  const locale = {
    activeLanguage: 'en',
    register: () => () => {},
    bind: () => (key) => undefined,
  }
  const ctx = {
    get: (name) => (name === 'slots' ? slots : locale),
    effect: () => {},
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => sandbox.__mod = mod } },
    document: { addEventListener() {}, removeEventListener() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  const exported = sandbox.__mod.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require("${id}")`)
  })
  exported.apply(ctx)
  return { registrations, react }
}

/** Evaluate function components so the tree holds host elements only. */
function resolve(node) {
  if (Array.isArray(node)) return node.map(resolve)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return resolve(node.type(node.props))
  return { ...node, props: { ...node.props, children: resolve(node.props?.children) } }
}

/** @param {object} node - element tree. @returns {string} all text in the tree. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return [textOf(node.props?.children), node.props?.title, node.props?.['aria-expanded']].filter(Boolean).join(' ')
}

/** @param {object} node - element tree. @param {(node: object) => boolean} predicate - filter. @returns {object[]} matches. */
function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (node.type && predicate(node)) found.push(node)
  const children = node.props?.children
  if (Array.isArray(children)) for (const child of children) findAll(child, predicate, found)
  else if (children) findAll(children, predicate, found)
  return found
}

const checks = []
/** @param {string} name - check name. @param {() => void} body - assertions. */
function check(name, body) {
  try {
    body()
    checks.push(`ok   ${name}`)
  } catch (error) {
    checks.push(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const tunnel = {
  key: 'https://example.test/ws-1',
  label: 'dev',
  wsId: 'ws-1',
  localPort: 41000,
  active: true,
  sftp: { localPort: 41001 },
}

const { registrations } = loadClient({ state: { tunnels: [tunnel] }, open: true })
const overlay = registrations.find((entry) => entry.meta.name === 'shell.overlay')
const settings = registrations.find((entry) => entry.meta.name === 'settings.section')

check('registers a settings section and a shell overlay seat', () => {
  assert.ok(settings, 'settings.section is not registered')
  assert.ok(overlay, 'shell.overlay is not registered')
})

const chipTree = resolve(overlay.component())
const chipText = textOf(chipTree)

check('the chip shows the number of connected dev spaces', () => {
  assert.match(chipText, /BAS/)
  assert.match(chipText, /\b1\b/)
})

check('the chip is anchored, not a full-width band', () => {
  const anchor = findAll(chipTree, (node) => node.props?.style?.position === 'absolute')[0]
  assert.ok(anchor, 'no absolutely positioned anchor')
  assert.equal(anchor.props.style.bottom, 12)
  assert.equal(anchor.props.style.right, 12)
  const chip = findAll(chipTree, (node) => node.props?.style?.width === 'max-content')[0]
  assert.ok(chip, 'the chip itself is not width: max-content')
})

check('clicking the chip opens a panel with both endpoints and no leaked keys', () => {
  assert.match(chipText, /dev/)
  assert.match(chipText, /ssh 127\.0\.0\.1:41000/)
  assert.match(chipText, /sftp 127\.0\.0\.1:41001/)
  assert.match(chipText, /BAS remote dev spaces/)
  assert.doesNotMatch(chipText, /pill\./)
})

const hidden = resolve(
  loadClient({ state: { tunnels: [] } })
    .registrations.find((entry) => entry.meta.name === 'shell.overlay')
    .component(),
)
check('the chip renders nothing when no dev space is connected', () => {
  assert.equal(hidden, null)
})

// Every tr('key') must exist in both locale tables, or the UI shows the raw key.
const zh = SOURCE.slice(SOURCE.indexOf('zh: {'), SOURCE.indexOf('en: {'))
const en = SOURCE.slice(SOURCE.indexOf('en: {'), SOURCE.indexOf('// ──', SOURCE.indexOf('en: {')))
const keys = [...new Set([...SOURCE.matchAll(/tr\('([^']+)'/g)].map((match) => match[1]))]
check(`all ${keys.length} translated keys exist in both languages`, () => {
  const missing = keys.filter((key) => !zh.includes(`'${key}'`) || !en.includes(`'${key}'`))
  assert.deepEqual(missing, [])
})

console.log(checks.join('\n'))
console.log(process.exitCode ? '\nClient: FAILED' : `\nClient: ${checks.length} checks passed`)
