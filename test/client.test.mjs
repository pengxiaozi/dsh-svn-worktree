/**
 * Client-half smoke test: loads `client/client.js` the way the browser module
 * loader does, mounts it against a fake Cordis client context, and renders the
 * tab body, tab title and header button with a minimal stand-in for React.
 *
 * It proves the module loads, registers its tab type, slots and header entry,
 * and that every component renders once without throwing. It does not replace
 * looking at the panel in the running app.
 *
 * Run with: node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

/* --- a very small React stand-in ---------------------------------------- */
let stateCursor = 0
const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    stateCursor += 1
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useMemo(factory) { return factory() },
  useCallback(fn) { return fn },
  useRef(value) { return { current: value } },
  Fragment: 'Fragment',
}
const hooks = ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useLayoutEffect']
const requireModule = (id) => {
  if (id === 'react') return { ...react, ...Object.fromEntries(hooks.map((name) => [name, react[name] ?? (() => {})])) }
  throw new Error('unexpected module request: ' + id)
}

/* --- a document good enough for the style injection --------------------- */
const appended = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, setAttribute() {}, appendChild() {}, textContent: '' }),
  head: { appendChild: (node) => appended.push(node) },
}

/* --- load the module through the real loader contract ------------------- */
let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { loaded = spec },
  },
}
await import(pathToFileURL(join(here, '..', 'client', 'client.js')).href)
assert.ok(loaded, 'module loader contract')
assert.equal(loaded.id, 'dsh-svn-worktree')
const module = loaded.factory(requireModule)
assert.equal(module.name, 'dsh-svn-worktree')
assert.deepEqual(module.inject, ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'])

/* --- mount against a fake client context -------------------------------- */
const registered = { tabs: [], slots: [], dictionaries: [] }
const context = {
  get(service) {
    if (service === 'sidebarRight') return { openTab(kind) { registered.opened = kind } }
    return undefined
  },
  effect(callback) { return callback() },
  locale: { register(namespace, dictionaries) { registered.dictionaries.push({ namespace, dictionaries }) } },
  sidebarRightTabs: { register(definition) { registered.tabs.push(definition) } },
  slots: {
    inject(name, callback) { const off = callback(); registered.slots.push({ name, off }); return off },
    register(name, component) { return { name, component } },
  },
}
module.apply(context)

assert.equal(appended.length, 1, 'styles injected once')
assert.equal(registered.dictionaries.length, 1)
assert.equal(registered.tabs.length, 1)
const tab = registered.tabs[0]
assert.equal(tab.id, 'dsh-svn-worktree')
assert.equal(tab.kind, 'svn-worktree')
assert.deepEqual(tab.guide.map((entry) => entry.id), ['changes'])
assert.equal(registered.slots.length, 3)
assert.deepEqual(registered.slots.map((slot) => slot.name), [
  'sidebar.right.pane.tab',
  'sidebar.right.pane.tab.title',
  'conversation.session.header.utilities',
])

/* --- render every component once --------------------------------------- */
const components = Object.fromEntries(registered.slots.map((slot) => [slot.name, slot.off.component]))
const header = components['conversation.session.header.utilities']
const tabBody = components['sidebar.right.pane.tab']
const tabTitle = components['sidebar.right.pane.tab.title']
const t = (key) => 't:' + key
const translate = (key) => key

stateCursor = 0
const headerTree = header({ t, openSvnPanel: () => {} })
assert.equal(headerTree.type, 'button')
assert.equal(headerTree.props.type, 'button')
assert.equal(typeof headerTree.props.title, 'string')

stateCursor = 0
const titleTree = tabTitle({ t })
assert.equal(titleTree.type, 'span')
assert.equal(titleTree.props.className, 'svw-title')

stateCursor = 0
const bodyTree = tabBody({ sessionId: 'session-test', t })
assert.equal(bodyTree.type, 'div')
assert.ok(bodyTree.children.length > 0, 'panel body renders children')

console.log('panel body root class:', bodyTree.props.className)
console.log('registered tab kind  :', tab.kind, '| title:', tab.title(), '| guide:', tab.guide[0].title())
console.log('header label         :', headerTree.children.join(''))
assert.equal(typeof translate('tab.title'), 'string')

console.log('client.test.mjs: all assertions passed')
