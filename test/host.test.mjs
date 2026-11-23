/**
 * Host-half integration test: builds a throwaway local SVN repository, mounts
 * the plugin against a fake Cordis context, then drives the HTTP routes the
 * panel uses in production.
 *
 * Run with: node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name } from '../lib/index.js'

const WINDOWS = process.platform === 'win32'
const SVN = process.env.SVN_COMMAND || (WINDOWS ? 'D:/devsoftware/svn-cli/bin/svn.exe' : 'svn')
const SVNADMIN = process.env.SVNADMIN_COMMAND || (WINDOWS ? 'D:/devsoftware/svn-cli/bin/svnadmin.exe' : 'svnadmin')

/**
 * Run one svn-family command and fail loudly on a non-zero exit.
 * @param command - executable.
 * @param args - argument vector.
 * @param cwd - working directory.
 * @returns stdout text.
 */
function run(command, args, cwd) {
  const extra = command === SVNADMIN ? [] : ['--non-interactive']
  const result = spawnSync(command, [...args, ...extra], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

/**
 * Build a request whose body is the given payload.
 * @param url - request URL.
 * @param method - HTTP method.
 * @param body - JSON body or undefined.
 * @returns a readable request.
 */
function makeRequest(url, method, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  request.url = url
  request.method = method ?? (body === undefined ? 'GET' : 'POST')
  return request
}

/**
 * Invoke one captured route.
 * @param routes - captured route map.
 * @param path - route path.
 * @param options - query, method, body.
 * @returns parsed JSON response.
 */
async function call(routes, path, options = {}) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error('route missing: ' + path)
  const query = new URLSearchParams()
  if (options.sessionId !== undefined) query.set('sessionId', options.sessionId)
  for (const key of Object.keys(options.query ?? {})) query.set(key, String(options.query[key]))
  const url = path + (query.toString() === '' ? '' : '?' + query.toString())
  const response = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    end(chunk) { this.body = chunk ?? '' },
  }
  await handler(makeRequest(url, options.method, options.body), response)
  return { status: response.statusCode, ...JSON.parse(response.body || '{}') }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-svn-test-'))
const repo = join(root, 'repo')
const project = join(root, 'project')
const sessionId = 'session-test'

try {
  // --- fixture: repository with trunk/branches and a working copy ---------
  run(SVNADMIN, ['create', repo])
  const repoUrl = 'file:///' + repo.replace(/\\/g, '/')
  run(SVN, ['mkdir', repoUrl + '/trunk', repoUrl + '/branches', '-m', 'init'])
  mkdirSync(project, { recursive: true })
  run(SVN, ['checkout', repoUrl + '/trunk', join(project, 'wc')], root)
  writeFileSync(join(project, 'wc', 'app.txt'), 'line one\n')
  run(SVN, ['add', 'app.txt'], join(project, 'wc'))
  run(SVN, ['commit', '-m', 'seed'], join(project, 'wc'))

  // --- fake Cordis context ------------------------------------------------
  const routes = new Map()
  const workingDirectories = new Map([[sessionId, join(project, 'wc')]])
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
          async set(_agent, path) { workingDirectories.set(sessionId, path); return path },
        }
      }
      if (service === 'sessions') {
        return { get: (id) => (workingDirectories.has(id) ? { id } : undefined) }
      }
      if (service === 'agents') {
        return { get: (id) => (workingDirectories.has(id) ? { id } : undefined) }
      }
      if (service === 'tools') {
        return { register: () => () => {} }
      }
      return undefined
    },
    inject(_names, callback) {
      const host = {}
      for (const service of _names) host[service] = ctx.get(service)
      callback(host)
    },
    effect(callback) { return callback() },
  }

  const config = { svnCommand: SVN }
  apply(ctx, config)

  assert.equal(name, 'svn-worktree')
  assert.ok(routes.has('/dsh-svn-worktree/health'), 'health route')
  assert.equal((await call(routes, '/dsh-svn-worktree/health')).ok, true)

  // --- /state sees the working copy and no worktrees ----------------------
  const initial = await call(routes, '/dsh-svn-worktree/state', { sessionId })
  assert.equal(initial.ok, true, initial.error)
  assert.equal(initial.workspace.kind, 'svn')
  assert.ok(initial.workspace.url.endsWith('/trunk'), initial.workspace.url)
  assert.equal(initial.current, null)
  assert.deepEqual(initial.worktrees, [])
  assert.equal(initial.projectRoot, join(project, 'wc'))

  // --- /changes reports a modified file and an unversioned file ----------
  appendFileSync(join(project, 'wc', 'app.txt'), 'line two\n')
  writeFileSync(join(project, 'wc', 'new.txt'), 'brand new\n')
  const changes = await call(routes, '/dsh-svn-worktree/changes', { sessionId })
  assert.equal(changes.ok, true, changes.error)
  const byPath = Object.fromEntries(changes.files.map((file) => [file.path, file]))
  assert.equal(byPath['app.txt'].status, 'modified')
  assert.equal(byPath['new.txt'].status, 'unversioned')

  // --- /diff renders the change ------------------------------------------
  const diff = await call(routes, '/dsh-svn-worktree/diff', { sessionId, query: { path: 'app.txt' } })
  assert.equal(diff.ok, true, diff.error)
  assert.ok(diff.diff.includes('line two'), diff.diff)
  assert.ok(diff.diff.includes('+line two'), 'unified add marker')

  // --- /add stages the unversioned file ----------------------------------
  const added = await call(routes, '/dsh-svn-worktree/add', { sessionId, body: { paths: ['new.txt'] } })
  assert.equal(added.ok, true, added.error)

  // --- /commit commits the selection -------------------------------------
  const committed = await call(routes, '/dsh-svn-worktree/commit', {
    sessionId,
    body: { message: '第一行改动', paths: ['app.txt', 'new.txt'] },
  })
  assert.equal(committed.ok, true, committed.error)
  assert.ok(Number.isInteger(committed.revision), 'commit revision: ' + String(committed.revision))

  const afterCommit = await call(routes, '/dsh-svn-worktree/changes', { sessionId })
  assert.equal(afterCommit.ok, true, afterCommit.error)
  assert.deepEqual(afterCommit.files, [])

  // --- /worktrees/create makes a branch and a checkout -------------------
  const created = await call(routes, '/dsh-svn-worktree/worktrees/create', {
    sessionId,
    body: { name: 'fix-login-retry', enter: false },
  })
  assert.equal(created.ok, true, created.error)
  assert.ok(created.branchUrl.endsWith('/branches/fix-login-retry'), created.branchUrl)
  assert.ok(created.path.endsWith(join('.agents', 'worktrees', 'fix-login-retry')), created.path)
  assert.equal(workingDirectories.get(sessionId), join(project, 'wc'), 'enter:false keeps the session put')

  // --- the same name must fail ------------------------------------------
  const duplicate = await call(routes, '/dsh-svn-worktree/worktrees/create', {
    sessionId,
    body: { name: 'fix-login-retry' },
  })
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.error, /已存在/)

  // --- /state lists the worktree ----------------------------------------
  const listed = await call(routes, '/dsh-svn-worktree/state', { sessionId })
  assert.equal(listed.ok, true, listed.error)
  assert.equal(listed.worktrees.length, 1)
  assert.equal(listed.worktrees[0].name, 'fix-login-retry')
  assert.ok(listed.worktrees[0].url.endsWith('/branches/fix-login-retry'))

  // --- /worktrees/enter switches the session cwd ------------------------
  const entered = await call(routes, '/dsh-svn-worktree/worktrees/enter', {
    sessionId,
    body: { name: 'fix-login-retry' },
  })
  assert.equal(entered.ok, true, entered.error)
  assert.equal(workingDirectories.get(sessionId), created.path)

  // --- inside a worktree the panel still resolves the project root ------
  const inside = await call(routes, '/dsh-svn-worktree/state', { sessionId })
  assert.equal(inside.current, 'fix-login-retry')
  assert.equal(inside.projectRoot, join(project, 'wc'))
  assert.equal(inside.worktrees.length, 1)

  // --- a worktree in use refuses removal ---------------------------------
  writeFileSync(join(created.path, 'dirty.txt'), 'x\n')
  const inUse = await call(routes, '/dsh-svn-worktree/worktrees/remove', {
    sessionId,
    body: { name: 'fix-login-retry' },
  })
  assert.equal(inUse.ok, false)
  assert.match(inUse.error, /正在使用/)

  // --- a dirty worktree refuses silent deletion -------------------------
  workingDirectories.set(sessionId, join(project, 'wc'))
  const refused = await call(routes, '/dsh-svn-worktree/worktrees/remove', {
    sessionId,
    body: { name: 'fix-login-retry' },
  })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /未提交/)

  // --- discard removes it without touching the branch -------------------
  const discarded = await call(routes, '/dsh-svn-worktree/worktrees/remove', {
    sessionId,
    body: { name: 'fix-login-retry', discard: true },
  })
  assert.equal(discarded.ok, true, discarded.error)

  const final = await call(routes, '/dsh-svn-worktree/state', { sessionId })
  assert.deepEqual(final.worktrees, [])

  // --- the branch itself stays on the server ---------------------------
  const branchInfo = run(SVN, ['info', created.branchUrl], root)
  assert.match(branchInfo, /分支|branch|trunk|URL/i)

  // --- invalid names are rejected --------------------------------------
  const badName = await call(routes, '/dsh-svn-worktree/worktrees/create', {
    sessionId,
    body: { name: '../escape' },
  })
  assert.equal(badName.ok, false)
  assert.match(badName.error, /不能包含|只能包含/)

  // --- a checkout of the repository ROOT (the common real-world layout) --
  // Production working copies often hold the whole repository, so `trunk`
  // and `branches` are subdirectories of the checkout rather than its URL.
  const rootSession = 'session-root'
  const rootProject = join(root, 'root-project')
  const rootRepo = join(root, 'root-repo')
  run(SVNADMIN, ['create', rootRepo])
  const rootRepoUrl = 'file:///' + rootRepo.replace(/\\/g, '/')
  run(SVN, ['mkdir', rootRepoUrl + '/trunk', rootRepoUrl + '/branches', '-m', 'init'])
  mkdirSync(rootProject, { recursive: true })
  run(SVN, ['checkout', rootRepoUrl, join(rootProject, 'wc')], root)

  const rootRoutes = new Map()
  const rootDirectories = new Map([[rootSession, join(rootProject, 'wc')]])
  const rootCtx = {
    get(service) {
      if (service === 'webServer') {
        return {
          register(route) {
            rootRoutes.set(route.path, route.handler)
            return () => rootRoutes.delete(route.path)
          },
        }
      }
      if (service === 'workingDirectory') {
        return {
          get: (session) => rootDirectories.get(session.id),
          async set(_agent, path) { rootDirectories.set(rootSession, path); return path },
        }
      }
      if (service === 'sessions') return { get: (id) => (rootDirectories.has(id) ? { id } : undefined) }
      if (service === 'agents') return { get: (id) => (rootDirectories.has(id) ? { id } : undefined) }
      if (service === 'tools') return { register: () => () => {} }
      return undefined
    },
    inject(names, callback) {
      const host = {}
      for (const service of names) host[service] = rootCtx.get(service)
      callback(host)
    },
    effect(callback) { return callback() },
  }
  apply(rootCtx, { svnCommand: SVN })

  const rootState = await call(rootRoutes, '/dsh-svn-worktree/state', { sessionId: rootSession })
  assert.equal(rootState.ok, true, rootState.error)
  assert.equal(rootState.projectRoot, join(rootProject, 'wc'))
  assert.ok(rootState.workspace.url.endsWith('/root-repo'), rootState.workspace.url)

  const rootCreated = await call(rootRoutes, '/dsh-svn-worktree/worktrees/create', {
    sessionId: rootSession,
    body: { name: 'root-layout', enter: true },
  })
  assert.equal(rootCreated.ok, true, rootCreated.error)
  assert.ok(rootCreated.sourceUrl.endsWith('/trunk'), rootCreated.sourceUrl)
  assert.ok(rootCreated.branchUrl.endsWith('/branches/root-layout'), rootCreated.branchUrl)
  assert.equal(rootDirectories.get(rootSession), rootCreated.path)
  const enteredState = await call(rootRoutes, '/dsh-svn-worktree/state', { sessionId: rootSession })
  assert.equal(enteredState.current, 'root-layout')

  console.log('host.test.mjs: all assertions passed')
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
}
