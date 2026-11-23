/**
 * 宿主侧集成测试：搭建一个临时的本地 SVN 仓库，把插件挂到伪造的 Cordis
 * 上下文上，然后像面板在生产环境中那样驱动 HTTP 路由。
 *
 * 运行方式：node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name } from '../lib/index.js'

// svn / svnadmin 默认取 PATH 里的可执行文件，需要时用环境变量覆盖。
const SVN = process.env.SVN_COMMAND || 'svn'
const SVNADMIN = process.env.SVNADMIN_COMMAND || 'svnadmin'

/**
 * 执行一个 svn 系列命令，退出码非零时直接失败。
 * @param command - 可执行文件。
 * @param args - 参数数组。
 * @param cwd - 工作目录。
 * @returns stdout 文本。
 */
function run(command, args, cwd) {
  const extra = command === SVNADMIN ? [] : ['--non-interactive']
  const result = spawnSync(command, [...args, ...extra], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

/**
 * 构造一个带指定 JSON 请求体的请求对象。
 * @param url - 请求 URL。
 * @param method - HTTP 方法。
 * @param body - JSON 请求体，可为 undefined。
 * @returns 可读的请求对象。
 */
function makeRequest(url, method, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  request.url = url
  request.method = method ?? (body === undefined ? 'GET' : 'POST')
  return request
}

/**
 * 调用一个已捕获的路由。
 * @param routes - 已捕获的路由表。
 * @param path - 路由路径。
 * @param options - 查询参数、方法、请求体。
 * @returns 解析后的 JSON 响应。
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
  // --- 准备：带 trunk/branches 的仓库与一个工作副本 -----------------------
  run(SVNADMIN, ['create', repo])
  const repoUrl = 'file:///' + repo.replace(/\\/g, '/')
  run(SVN, ['mkdir', repoUrl + '/trunk', repoUrl + '/branches', '-m', 'init'])
  mkdirSync(project, { recursive: true })
  run(SVN, ['checkout', repoUrl + '/trunk', join(project, 'wc')], root)
  writeFileSync(join(project, 'wc', 'app.txt'), 'line one\n')
  run(SVN, ['add', 'app.txt'], join(project, 'wc'))
  run(SVN, ['commit', '-m', 'seed'], join(project, 'wc'))

  // --- 伪造的 Cordis 上下文 ----------------------------------------------
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

  // --- /state 能看到工作副本，此时还没有工作树 ----------------------------
  const initial = await call(routes, '/dsh-svn-worktree/state', { sessionId })
  assert.equal(initial.ok, true, initial.error)
  assert.equal(initial.workspace.kind, 'svn')
  assert.ok(initial.workspace.url.endsWith('/trunk'), initial.workspace.url)
  assert.equal(initial.current, null)
  assert.deepEqual(initial.worktrees, [])
  assert.equal(initial.projectRoot, join(project, 'wc'))

  // --- /changes 报告一个已修改文件和一个未纳入版本控制的文件 --------------
  appendFileSync(join(project, 'wc', 'app.txt'), 'line two\n')
  writeFileSync(join(project, 'wc', 'new.txt'), 'brand new\n')
  const changes = await call(routes, '/dsh-svn-worktree/changes', { sessionId })
  assert.equal(changes.ok, true, changes.error)
  const byPath = Object.fromEntries(changes.files.map((file) => [file.path, file]))
  assert.equal(byPath['app.txt'].status, 'modified')
  assert.equal(byPath['new.txt'].status, 'unversioned')

  // --- /diff 渲染这处变更 ------------------------------------------------
  const diff = await call(routes, '/dsh-svn-worktree/diff', { sessionId, query: { path: 'app.txt' } })
  assert.equal(diff.ok, true, diff.error)
  assert.ok(diff.diff.includes('line two'), diff.diff)
  assert.ok(diff.diff.includes('+line two'), 'unified add marker')

  // --- /add 把未纳入版本控制的文件加入版本控制 ----------------------------
  const added = await call(routes, '/dsh-svn-worktree/add', { sessionId, body: { paths: ['new.txt'] } })
  assert.equal(added.ok, true, added.error)

  // --- /commit 提交选中的文件 --------------------------------------------
  const committed = await call(routes, '/dsh-svn-worktree/commit', {
    sessionId,
    body: { message: '第一行改动', paths: ['app.txt', 'new.txt'] },
  })
  assert.equal(committed.ok, true, committed.error)
  assert.ok(Number.isInteger(committed.revision), 'commit revision: ' + String(committed.revision))

  const afterCommit = await call(routes, '/dsh-svn-worktree/changes', { sessionId })
  assert.equal(afterCommit.ok, true, afterCommit.error)
  assert.deepEqual(afterCommit.files, [])

  // --- /worktrees/create 建分支并检出 -------------------------------------
  const created = await call(routes, '/dsh-svn-worktree/worktrees/create', {
    sessionId,
    body: { name: 'fix-login-retry', enter: false },
  })
  assert.equal(created.ok, true, created.error)
  assert.ok(created.branchUrl.endsWith('/branches/fix-login-retry'), created.branchUrl)
  assert.ok(created.path.endsWith(join('.agents', 'worktrees', 'fix-login-retry')), created.path)
  assert.equal(workingDirectories.get(sessionId), join(project, 'wc'), 'enter:false keeps the session put')

  // --- 同名再建必须失败 --------------------------------------------------
  const duplicate = await call(routes, '/dsh-svn-worktree/worktrees/create', {
    sessionId,
    body: { name: 'fix-login-retry' },
  })
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.error, /已存在/)

  // --- /state 列出该工作树 ------------------------------------------------
  const listed = await call(routes, '/dsh-svn-worktree/state', { sessionId })
  assert.equal(listed.ok, true, listed.error)
  assert.equal(listed.worktrees.length, 1)
  assert.equal(listed.worktrees[0].name, 'fix-login-retry')
  assert.ok(listed.worktrees[0].url.endsWith('/branches/fix-login-retry'))

  // --- /worktrees/enter 切换会话目录 -------------------------------------
  const entered = await call(routes, '/dsh-svn-worktree/worktrees/enter', {
    sessionId,
    body: { name: 'fix-login-retry' },
  })
  assert.equal(entered.ok, true, entered.error)
  assert.equal(workingDirectories.get(sessionId), created.path)

  // --- 在工作树内部仍能解析到项目根目录 ----------------------------------
  const inside = await call(routes, '/dsh-svn-worktree/state', { sessionId })
  assert.equal(inside.current, 'fix-login-retry')
  assert.equal(inside.projectRoot, join(project, 'wc'))
  assert.equal(inside.worktrees.length, 1)

  // --- 正在使用中的工作树拒绝删除 ----------------------------------------
  writeFileSync(join(created.path, 'dirty.txt'), 'x\n')
  const inUse = await call(routes, '/dsh-svn-worktree/worktrees/remove', {
    sessionId,
    body: { name: 'fix-login-retry' },
  })
  assert.equal(inUse.ok, false)
  assert.match(inUse.error, /正在使用/)

  // --- 有未提交改动的工作树拒绝静默删除 ----------------------------------
  workingDirectories.set(sessionId, join(project, 'wc'))
  const refused = await call(routes, '/dsh-svn-worktree/worktrees/remove', {
    sessionId,
    body: { name: 'fix-login-retry' },
  })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /未提交/)

  // --- discard 只删检出，不动服务端分支 ----------------------------------
  const discarded = await call(routes, '/dsh-svn-worktree/worktrees/remove', {
    sessionId,
    body: { name: 'fix-login-retry', discard: true },
  })
  assert.equal(discarded.ok, true, discarded.error)

  const final = await call(routes, '/dsh-svn-worktree/state', { sessionId })
  assert.deepEqual(final.worktrees, [])

  // --- 服务端的分支依然存在 ----------------------------------------------
  const branchInfo = run(SVN, ['info', created.branchUrl], root)
  assert.match(branchInfo, /分支|branch|trunk|URL/i)

  // --- 非法名称会被拒绝 --------------------------------------------------
  const badName = await call(routes, '/dsh-svn-worktree/worktrees/create', {
    sessionId,
    body: { name: '../escape' },
  })
  assert.equal(badName.ok, false)
  assert.match(badName.error, /不能包含|只能包含/)

  // --- 检出整个仓库根目录（真实环境里最常见的布局） ----------------------
  // 生产环境的工作副本常常包含整个仓库，因此 `trunk` 与 `branches`
  // 是检出目录下的子目录，而不是检出本身的 URL。
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
