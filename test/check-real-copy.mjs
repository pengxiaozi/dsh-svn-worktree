/**
 * Read-only smoke check against a real, existing SVN working copy: mounts the
 * host half against a fake Cordis context whose Session lives in that checkout
 * and reads state/changes/diff without modifying anything.
 *
 * Run with: node test/check-real-copy.mjs [path-to-working-copy]
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { apply } from '../lib/index.js'

const SVN = process.env.SVN_COMMAND || (process.platform === 'win32' ? 'D:/devsoftware/svn-cli/bin/svn.exe' : 'svn')
const target = process.argv[2] || 'D:\\devsoftware\\php\\phpstudy_pro\\WWW\\cjzj'
const sessionId = 'session-real-copy'

const routes = new Map()
const workingDirectories = new Map([[sessionId, target]])
const ctx = {
  get(service) {
    if (service === 'webServer') {
      return {
        register(route) {
          routes.set(route.path, route.handler)
          return () => routes.delete(route.path)
        },
      }
    }
    if (service === 'workingDirectory') {
      return {
        get: (session) => workingDirectories.get(session.id),
        async set() { throw new Error('read-only check must not change the working directory') },
      }
    }
    if (service === 'sessions') return { get: (id) => (workingDirectories.has(id) ? { id } : undefined) }
    if (service === 'agents') return { get: (id) => (workingDirectories.has(id) ? { id } : undefined) }
    if (service === 'tools') return { register: () => () => {} }
    return undefined
  },
  inject(names, callback) {
    const host = {}
    for (const service of names) host[service] = ctx.get(service)
    callback(host)
  },
  effect(callback) { return callback() },
}

/**
 * Invoke one captured route with a GET query string.
 * @param path - route path.
 * @param query - query parameters.
 * @returns parsed JSON response.
 */
async function read(path, query = {}) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error('route missing: ' + path)
  const params = new URLSearchParams({ sessionId, ...query })
  const request = Readable.from([])
  request.url = path + '?' + params.toString()
  request.method = 'GET'
  const response = {
    statusCode: 200,
    body: '',
    setHeader() {},
    end(chunk) { this.body = chunk ?? '' },
  }
  await handler(request, response)
  return { status: response.statusCode, ...JSON.parse(response.body || '{}') }
}

apply(ctx, { svnCommand: SVN })

const state = await read('/dsh-svn-worktree/state')
assert.equal(state.ok, true, state.error)
console.log('workspace   :', state.workspace.kind, state.workspace.url, 'r' + state.workspace.revision)
console.log('projectRoot :', state.projectRoot)
console.log('worktrees   :', state.worktrees.length)

const changes = await read('/dsh-svn-worktree/changes')
assert.equal(changes.ok, true, changes.error)
console.log('changed files:', changes.files.length)
for (const file of changes.files.slice(0, 10)) console.log('  -', file.status.padEnd(11), file.path)

const first = changes.files.find((file) => file.status !== 'unversioned' && file.status !== 'missing')
if (first !== undefined) {
  const diff = await read('/dsh-svn-worktree/diff', { path: first.path })
  assert.equal(diff.ok, true, diff.error)
  console.log('diff lines  :', diff.diff.split('\n').length, 'for', first.path)
}

console.log('check-real-copy.mjs: all assertions passed')
