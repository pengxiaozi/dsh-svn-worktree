/**
 * 客户端冒烟测试：按照浏览器模块加载器的方式载入 `client/client.js`，
 * 把它挂到伪造的 Cordis 客户端上下文上，再用极简的 React 替身渲染
 * 页签正文、页签标题与会话头部按钮。
 *
 * 它证明模块能被载入、页签类型/插槽/头部入口都注册成功，并且每个组件都能
 * 渲染一次而不抛错。它不能替代在真实应用中查看面板。
 *
 * 运行方式：node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8')

/* --- 极简的 React 替身 -------------------------------------------------- */
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

/* --- 足以支撑样式注入的 document 替身 ---------------------------------- */
const appended = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, setAttribute() {}, appendChild() {}, textContent: '' }),
  head: { appendChild: (node) => appended.push(node) },
}

/* --- 按真实加载器契约载入模块 ------------------------------------------ */
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

/* --- 挂载到伪造的客户端上下文上 ---------------------------------------- */
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

/* --- 把每个组件各渲染一次 ---------------------------------------------- */
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
