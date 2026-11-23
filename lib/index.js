/**
 * Host half of `dsh-svn-worktree`: detects the SVN working copy of a Session,
 * creates branch worktrees (`svn copy` + `svn checkout`), lists changes,
 * renders diffs and commits selected files.
 *
 * The browser talks to the routes registered here; the model talks to the
 * `create_svn_worktree` tool. Both go through the same helpers, so the panel
 * and the model see one state.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** Cordis plugin name. */
export const name = 'svn-worktree'

/** Route prefix shared by every endpoint below. */
const ROUTE = '/dsh-svn-worktree'

/** Resolved plugin defaults. */
const DEFAULTS = {
  svnCommand: 'svn',
  directory: '.agents/worktrees',
  trunkPath: 'trunk',
  branchesPath: 'branches',
  timeoutMs: 300000,
  quickTimeoutMs: 120000,
  maxOutputBytes: 65536,
  maxDiffBytes: 200000,
  maxFiles: 500,
  copyMessage: '创建分支 {name}',
}

/**
 * Merge plugin config over the defaults.
 * @param config - raw row config from the Loader.
 * @returns the effective settings.
 */
function settings(config) {
  const merged = { ...DEFAULTS }
  if (config !== null && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      const value = config[key]
      if (value !== undefined && value !== null) merged[key] = value
    }
  }
  merged.directory = String(merged.directory).replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '') || DEFAULTS.directory
  merged.trunkPath = String(merged.trunkPath).replace(/^\/+|\/+$/g, '')
  merged.branchesPath = String(merged.branchesPath).replace(/^\/+|\/+$/g, '')
  return merged
}

/**
 * Run one child process and collect bounded output.
 * @param command - executable.
 * @param args - argument vector.
 * @param options - working directory, timeout, output cap, cancellation.
 * @returns exit code and decoded streams.
 */
function runCommand(command, args, options = {}) {
  const { cwd, timeoutMs = 120000, maxOutputBytes = 65536, signal } = options
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', LC_MESSAGES: 'C' },
      })
    } catch (error) {
      reject(error)
      return
    }
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    let timedOut = false
    let settled = false
    const append = (current, chunk) => {
      if (current.length >= maxOutputBytes) return current
      return Buffer.concat([current, chunk]).subarray(0, maxOutputBytes)
    }
    child.stdout.on('data', (chunk) => { out = append(out, chunk) })
    child.stderr.on('data', (chunk) => { err = append(err, chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, timeoutMs)
    const onAbort = () => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const cleanup = () => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise({ code: code === null ? 1 : code, stdout: out.toString('utf8'), stderr: err.toString('utf8'), timedOut })
    })
  })
}

/**
 * Build the `svn` caller for one settings object.
 * @param config - effective settings.
 * @returns a caller resolving to exit code and streams.
 */
function svnCaller(config) {
  return function svn(args, options = {}) {
    return runCommand(config.svnCommand, [...args, '--non-interactive', '--no-auth-cache'], {
      timeoutMs: config.quickTimeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      ...options,
    })
  }
}

/**
 * Read one element's text out of an XML fragment.
 * @param fragment - XML text.
 * @param tag - element name.
 * @returns decoded text, or undefined.
 */
function xmlText(fragment, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(fragment)
  if (match === null) return undefined
  return decodeXml(match[1].trim())
}

/**
 * Decode the five XML entities Subversion writes.
 * @param value - escaped text.
 * @returns plain text.
 */
function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Report a failed svn invocation as an Error carrying its stderr.
 * @param result - finished invocation.
 * @param fallback - message used when svn printed nothing.
 * @returns the error to throw.
 */
function svnFailure(result, fallback) {
  const detail = (result.stderr || result.stdout || '').trim()
  const reason = result.timedOut ? 'svn 命令超时' : (detail.split(/\r?\n/).filter(Boolean).slice(-3).join('\n') || fallback)
  const error = new Error(reason)
  error.svnCode = result.code
  return error
}

/**
 * Inspect a directory's SVN working copy.
 * @param svn - svn caller.
 * @param path - directory to inspect.
 * @returns the workspace description, or `{ kind: 'none' }`.
 */
async function inspectWorkspace(svn, path) {
  const result = await svn(['info', '--xml', path])
  if (result.code !== 0) return { kind: 'none', cwd: path }
  const root = xmlText(result.stdout, 'root')
  const url = xmlText(result.stdout, 'url')
  const wcroot = xmlText(result.stdout, 'wcroot-abspath')
  const revision = /<entry[^>]*\srevision="(\d+)"/.exec(result.stdout)
  if (url === undefined || root === undefined) return { kind: 'none', cwd: path }
  const relative = url.startsWith(root) ? url.slice(root.length) : url
  return {
    kind: 'svn',
    cwd: path,
    wcroot: wcroot === undefined ? path : wcroot,
    url,
    reposRootUrl: root,
    relativeUrl: relative === '' ? '/' : relative,
    revision: revision === null ? null : Number(revision[1]),
  }
}

/**
 * Split a worktree checkout path back into its project root and worktree name.
 * @param path - absolute checkout path.
 * @param directory - configured worktree directory, slash separated.
 * @returns project root and the worktree name when the path is inside one.
 */
function dissectWorktreePath(path, directory) {
  const segments = path.split(/[\\/]/).filter(Boolean)
  const marker = directory.split('/').filter(Boolean)
  for (let index = 0; index + marker.length <= segments.length; index += 1) {
    let matched = true
    for (let offset = 0; offset < marker.length; offset += 1) {
      if (segments[index + offset] !== marker[offset]) { matched = false; break }
    }
    if (!matched) continue
    const rootSegments = segments.slice(0, index)
    const nameSegments = segments.slice(index + marker.length)
    const projectRoot = rootSegments.join(sep)
    return {
      projectRoot: projectRoot === '' ? sep : (process.platform === 'win32' && /^[A-Za-z]:$/.test(projectRoot) ? projectRoot + sep : projectRoot),
      name: nameSegments.length === 0 ? null : nameSegments.join('/'),
    }
  }
  return { projectRoot: resolve(path), name: null }
}

/**
 * List worktree checkouts below one base directory.
 * @param svn - svn caller.
 * @param base - worktree base directory.
 * @param config - effective settings.
 * @returns one record per checkout, newest directory order.
 */
async function listWorktrees(svn, base, config) {
  if (!existsSync(base)) return []
  const found = []
  const walk = (directory, depth) => {
    if (depth > 3) return
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = join(directory, entry.name)
      if (existsSync(join(child, '.svn'))) {
        found.push(child)
        continue
      }
      walk(child, depth + 1)
    }
  }
  walk(base, 0)
  found.sort()
  const records = []
  for (const path of found) {
    const record = {
      name: path.slice(base.length + 1).split(sep).join('/'),
      path,
      url: null,
      revision: null,
      ok: true,
    }
    const info = await svn(['info', '--xml', path])
    if (info.code === 0) {
      record.url = xmlText(info.stdout, 'url') ?? null
      const revision = /<entry[^>]*\srevision="(\d+)"/.exec(info.stdout)
      record.revision = revision === null ? null : Number(revision[1])
      const relative = xmlText(info.stdout, 'relative-url')
      record.relativeUrl = relative === undefined ? null : relative.replace(/^\^/, '')
    } else {
      record.ok = false
    }
    records.push(record)
  }
  return records
}

/**
 * Express one path relative to a root, using forward slashes.
 * @param root - containing directory.
 * @param path - absolute or root-relative path.
 * @returns the relative path with `/` separators.
 */
function relativeTo(root, path) {
  const absolute = isAbsolute(path) ? path : join(root, path)
  const from = resolve(root)
  const to = resolve(absolute)
  if (to.toLowerCase() === from.toLowerCase()) return '.'
  if (to.toLowerCase().startsWith(from.toLowerCase() + sep)) {
    return to.slice(from.length + 1).split(sep).join('/')
  }
  return to.split(sep).join('/')
}

/**
 * Read the modified paths of one working copy.
 * @param svn - svn caller.
 * @param cwd - checkout to read.
 * @param config - effective settings.
 * @returns versioned and unversioned entries with their status.
 */
async function readChanges(svn, cwd, config) {
  const result = await svn(['status', '--xml', cwd])
  if (result.code !== 0) throw svnFailure(result, 'svn status 失败')
  const files = []
  const pattern = /<entry\s+path="([^"]*)"(?:\s+[^>]*)?>([\s\S]*?)<\/entry>/g
  let match
  while ((match = pattern.exec(result.stdout)) !== null) {
    const rawPath = decodeXml(match[1])
    const body = match[2]
    const statusTag = /<wc-status\s+([^>]*?)\/?>/.exec(body)
    if (statusTag === null) continue
    const attributes = statusTag[1]
    const read = (key) => {
      const found = new RegExp(`${key}="([^"]*)"`).exec(attributes)
      return found === null ? null : found[1]
    }
    const item = read('item') ?? 'normal'
    const props = read('props') ?? 'none'
    const treeConflicted = read('tree-conflicted') === 'true'
    if (item === 'normal' && props === 'none' && !treeConflicted) continue
    if (item === 'ignored' || item === 'external') continue
    files.push({
      path: relativeTo(cwd, rawPath),
      status: item,
      props,
      conflicted: item === 'conflicted' || treeConflicted,
      unversioned: item === 'unversioned',
    })
    if (files.length >= config.maxFiles) break
  }
  const info = await svn(['info', '--xml', cwd])
  const revision = info.code === 0 ? /<entry[^>]*\srevision="(\d+)"/.exec(info.stdout) : null
  return {
    files,
    truncated: files.length >= config.maxFiles,
    revision: revision === null ? null : Number(revision[1]),
  }
}

/**
 * Render a unified diff for the given paths.
 * @param svn - svn caller.
 * @param cwd - checkout to diff.
 * @param paths - relative paths; an empty list diffs the whole checkout.
 * @param config - effective settings.
 * @returns the capped diff text.
 */
async function readDiff(svn, cwd, paths, config) {
  const targets = paths.length > 0 ? paths : []
  const result = await svn(['diff', '--internal-diff', ...targets], {
    cwd,
    maxOutputBytes: config.maxDiffBytes,
    timeoutMs: config.quickTimeoutMs,
  })
  const text = result.stdout
  const failed = result.code !== 0 && text.trim() === ''
  return {
    diff: text,
    truncated: result.stdout.length >= config.maxDiffBytes,
    error: failed ? (result.stderr.trim() || 'svn diff 失败') : null,
  }
}

/**
 * Commit the selected paths of one checkout.
 * @param svn - svn caller.
 * @param cwd - checkout to commit.
 * @param request - log message and target paths.
 * @param config - effective settings.
 * @returns committed revision and svn output.
 */
async function commitPaths(svn, cwd, request, config) {
  const message = String(request.message ?? '').trim()
  if (message === '') throw new Error('提交日志不能为空')
  const paths = Array.isArray(request.paths) ? request.paths.map(String).filter(Boolean) : []
  if (paths.length === 0) throw new Error('请选择要提交的文件')
  const targets = join(tmpdir(), `dsh-svn-targets-${process.pid}-${Date.now()}.txt`)
  const logFile = join(tmpdir(), `dsh-svn-log-${process.pid}-${Date.now()}.txt`)
  writeFileSync(targets, paths.join('\n'), 'utf8')
  writeFileSync(logFile, message, 'utf8')
  try {
    const result = await svn(['commit', '-F', logFile, '--encoding', 'UTF-8', '--targets', targets], {
      cwd,
      timeoutMs: config.timeoutMs,
    })
    if (result.code !== 0) throw svnFailure(result, 'svn commit 失败')
    const committed = /Committed revision (\d+)/.exec(result.stdout + result.stderr)
    return {
      revision: committed === null ? null : Number(committed[1]),
      output: (result.stdout + result.stderr).trim(),
      message,
      paths,
    }
  } finally {
    try { unlinkSync(targets) } catch { /* temp file already gone */ }
    try { unlinkSync(logFile) } catch { /* temp file already gone */ }
  }
}

/**
 * Create the branch worktree for one Session checkout.
 * @param svn - svn caller.
 * @param request - checkout directory, name and optional base.
 * @param config - effective settings.
 * @param onPhase - progress callback.
 * @returns the created checkout description.
 */
async function createWorktree(svn, request, config, onPhase = () => {}) {
  const cwd = request.cwd
  if (typeof cwd !== 'string' || cwd === '') throw new Error('当前会话没有工作目录')
  const workspace = await inspectWorkspace(svn, cwd)
  if (workspace.kind !== 'svn') throw new Error('当前目录不是 SVN 工作副本：' + cwd)
  const name = String(request.name ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (name === '') throw new Error('请输入工作树名称')
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name)) throw new Error('工作树名称只能包含字母、数字、点、下划线、短横线，可用 / 分层：' + name)
  if (name.split('/').includes('..')) throw new Error('工作树名称不能包含 ..')
  const dissected = dissectWorktreePath(workspace.wcroot, config.directory)
  const projectRoot = dissected.projectRoot
  const base = join(projectRoot, ...config.directory.split('/'))
  const target = join(base, ...name.split('/'))
  if (!isInside(projectRoot, target)) throw new Error('工作树目录越界')
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error('目录已存在且非空：' + target)

  let sourceUrl = request.base ? resolveBaseUrl(workspace, String(request.base), config) : null
  if (sourceUrl === null) {
    const trunkUrl = joinUrl(workspace.reposRootUrl, config.trunkPath)
    const probe = await svn(['info', trunkUrl])
    sourceUrl = probe.code === 0 ? trunkUrl : workspace.url
  }
  const branchUrl = joinUrl(joinUrl(workspace.reposRootUrl, config.branchesPath), name)
  const existing = await svn(['info', branchUrl])
  if (existing.code === 0) throw new Error('分支已存在：' + branchUrl)

  onPhase('copy')
  const copyResult = await svn(['copy', sourceUrl, branchUrl, '-m', config.copyMessage.replace(/\{name\}/g, name)], {
    timeoutMs: config.timeoutMs,
  })
  if (copyResult.code !== 0) throw svnFailure(copyResult, 'svn copy 失败')

  onPhase('checkout')
  mkdirSync(base, { recursive: true })
  const checkout = await svn(['checkout', branchUrl, target], { timeoutMs: config.timeoutMs })
  if (checkout.code !== 0) throw svnFailure(checkout, 'svn checkout 失败')

  onPhase('verify')
  const info = await svn(['info', '--xml', target])
  const revision = info.code === 0 ? /<entry[^>]*\srevision="(\d+)"/.exec(info.stdout) : null
  return {
    name,
    path: target,
    branchUrl,
    sourceUrl,
    repositoryRoot: projectRoot,
    baseRevision: revision === null ? null : Number(revision[1]),
    revision: revision === null ? null : Number(revision[1]),
  }
}

/**
 * Resolve one base reference into an absolute repository URL.
 * @param workspace - inspected working copy.
 * @param base - URL, repository path, or branch name.
 * @param config - effective settings.
 * @returns the absolute URL.
 */
function resolveBaseUrl(workspace, base, config) {
  const value = base.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  if (value.startsWith('/')) return joinUrl(workspace.reposRootUrl, value.replace(/^\/+/, ''))
  return joinUrl(joinUrl(workspace.reposRootUrl, config.branchesPath), value)
}

/**
 * Join a base URL with one relative path.
 * @param base - URL without trailing slash.
 * @param path - relative path.
 * @returns the joined URL.
 */
function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + '/' + String(path).replace(/^\/+|\/+$/g, '')
}

/**
 * Test whether a path stays inside a directory.
 * @param parent - containing directory.
 * @param child - candidate path.
 * @returns whether the child resolves inside the parent.
 */
function isInside(parent, child) {
  const from = resolve(parent).toLowerCase()
  const to = resolve(child).toLowerCase()
  return to === from || to.startsWith(from.endsWith(sep) ? from : from + sep)
}

/**
 * Send one JSON response.
 * @param res - response.
 * @param status - HTTP status.
 * @param body - serializable payload.
 */
function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Read and parse a JSON request body.
 * @param req - request.
 * @returns the parsed body, or an empty object.
 */
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolveBody({}); return }
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(new Error('JSON 格式错误：' + error.message)) }
    })
    req.on('error', reject)
  })
}

/**
 * Register the `create_svn_worktree` model tool.
 * @param ctx - plugin context carrying the services.
 * @param config - effective settings.
 */
function registerTool(ctx, config) {
  ctx.inject(['tools'], (host) => {
    const tools = host.tools || ctx.get('tools')
    if (tools === undefined || typeof tools.register !== 'function') return
    const definition = {
      name: 'create_svn_worktree',
      description: 'Create an SVN branch (svn copy of trunk, then svn checkout) under .agents/worktrees/<name> and change this Session\'s working directory to it. The source working copy stays as it is; existing branch names fail. Use working_directory with cd to leave the checkout.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Branch and checkout name: a few lowercase words joined by hyphens, such as fix-login-retry. Slashes create nested branch paths.' },
          base: { type: 'string', description: 'Start point: an absolute repository URL, a repository path like /trunk, or a branch name under branches/.' },
          enter: { type: 'boolean', description: 'Change this Session\'s working directory to the new checkout. Defaults to true.' },
        },
        required: ['name'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            name: { type: 'string' },
            branchUrl: { type: 'string' },
            sourceUrl: { type: 'string' },
            repositoryRoot: { type: 'string' },
            revision: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'Checked-out revision, or null when the checkout reported none.' },
          },
          required: ['path', 'name', 'branchUrl', 'repositoryRoot'],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('create_svn_worktree 需要模型调用方')
        const workingDirectory = ctx.get('workingDirectory')
        if (workingDirectory === undefined) throw new Error('workingDirectory 服务不可用')
        const cwd = await workingDirectory.ensure(exec.agent, exec.signal)
        const svn = svnCaller(config)
        const created = await createWorktree(svn, { cwd, name: args.name, base: args.base }, config)
        if (args.enter !== false) await workingDirectory.set(exec.agent, created.path, exec.signal)
        return {
          path: created.path,
          name: created.name,
          branchUrl: created.branchUrl,
          sourceUrl: created.sourceUrl,
          repositoryRoot: created.repositoryRoot,
          revision: created.revision,
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'create_svn_worktree', rawInput: args }),
    }
    ctx.effect(() => tools.register(definition), 'svn-worktree: tool')
  })
}

/**
 * Register the browser routes of the panel.
 * @param ctx - plugin context carrying the services.
 * @param config - effective settings.
 */
function registerRoutes(ctx, config) {
  ctx.inject(['webServer'], (host) => {
    const webServer = host.webServer || ctx.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    const svn = svnCaller(config)

    const sessionOf = (request) => {
      const sessions = ctx.get('sessions')
      const id = request.sessionId === undefined ? '' : String(request.sessionId)
      const session = sessions === undefined || id === '' ? undefined : sessions.get(id)
      if (session === undefined) throw new Error('找不到会话：' + (id || '（未提供）'))
      return session
    }
    const directoryOf = (request) => {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory === undefined) throw new Error('workingDirectory 服务不可用')
      return workingDirectory.get(sessionOf(request))
    }
    const agentOf = (request) => {
      const agents = ctx.get('agents')
      const id = request.sessionId === undefined ? '' : String(request.sessionId)
      const agent = agents === undefined ? undefined : agents.get(id)
      if (agent === undefined) throw new Error('会话不在运行中：' + (id || '（未提供）'))
      return agent
    }
    /** Read `sessionId` from the query string of a request. */
    const querySessionId = (req) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      return url.searchParams.get('sessionId')
    }
    /** Merge the JSON body with the query `sessionId`. */
    const mergeRequest = (req, body) => {
      const fromQuery = querySessionId(req)
      return fromQuery === null ? body : { ...body, sessionId: fromQuery }
    }

    const routes = []

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/health',
      handler: (_req, res) => json(res, 200, { ok: true, plugin: name }),
    }))

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/state',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const cwd = directoryOf({ sessionId })
          const workspace = await inspectWorkspace(svn, cwd)
          const projectRoot = workspace.kind === 'svn'
            ? dissectWorktreePath(workspace.wcroot, config.directory).projectRoot
            : cwd
          const current = workspace.kind === 'svn'
            ? dissectWorktreePath(workspace.wcroot, config.directory).name
            : null
          const base = join(projectRoot, ...config.directory.split('/'))
          const worktrees = await listWorktrees(svn, base, config)
          json(res, 200, { ok: true, sessionId, cwd, workspace, projectRoot, current, base, worktrees })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      },
    }))

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/changes',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const cwd = directoryOf({ sessionId })
          const changes = await readChanges(svn, cwd, config)
          json(res, 200, { ok: true, cwd, ...changes })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      },
    }))

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/diff',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const path = url.searchParams.get('path') ?? ''
          const cwd = directoryOf({ sessionId })
          const paths = path === '' ? [] : [path]
          const rendered = await readDiff(svn, cwd, paths, config)
          json(res, 200, { ok: true, path, ...rendered })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      },
    }))

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/commit',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
          const body = mergeRequest(req, await readBody(req))
          const cwd = directoryOf(body)
          const committed = await commitPaths(svn, cwd, body, config)
          json(res, 200, { ok: true, ...committed })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      },
    }))

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/add',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
          const body = mergeRequest(req, await readBody(req))
          const cwd = directoryOf(body)
          const paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : []
          if (paths.length === 0) throw new Error('请选择要加入的文件')
          const result = await svn(['add', '--parents', '--depth', 'infinity', ...paths], { cwd })
          if (result.code !== 0) throw svnFailure(result, 'svn add 失败')
          json(res, 200, { ok: true, paths, output: (result.stdout + result.stderr).trim() })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      },
    }))

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/revert',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
          const body = mergeRequest(req, await readBody(req))
          const cwd = directoryOf(body)
          const paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : []
          if (paths.length === 0) throw new Error('请选择要撤销的文件')
          const result = await svn(['revert', '--depth', 'infinity', ...paths], { cwd })
          if (result.code !== 0) throw svnFailure(result, 'svn revert 失败')
          json(res, 200, { ok: true, paths, output: (result.stdout + result.stderr).trim() })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      },
    }))

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/update',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
          const body = mergeRequest(req, await readBody(req))
          const cwd = directoryOf(body)
          const result = await svn(['update'], { cwd, timeoutMs: config.timeoutMs })
          if (result.code !== 0) throw svnFailure(result, 'svn update 失败')
          const revision = /At revision (\d+)/.exec(result.stdout + result.stderr)
          json(res, 200, {
            ok: true,
            revision: revision === null ? null : Number(revision[1]),
            output: (result.stdout + result.stderr).trim(),
          })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      },
    }))

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/worktrees/create',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
          const body = mergeRequest(req, await readBody(req))
          const cwd = directoryOf(body)
          const created = await createWorktree(svn, { cwd, name: body.name, base: body.base }, config)
          if (body.enter === true) {
            const workingDirectory = ctx.get('workingDirectory')
            await workingDirectory.set(agentOf(body), created.path)
          }
          json(res, 200, { ok: true, ...created })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      },
    }))

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/worktrees/enter',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
          const body = mergeRequest(req, await readBody(req))
          const workingDirectory = ctx.get('workingDirectory')
          if (workingDirectory === undefined) throw new Error('workingDirectory 服务不可用')
          const cwd = directoryOf(body)
          const workspace = await inspectWorkspace(svn, cwd)
          const wcroot = workspace.kind === 'svn' ? workspace.wcroot : cwd
          const projectRoot = dissectWorktreePath(wcroot, config.directory).projectRoot
          const name = String(body.name ?? '').trim()
          if (name === '') throw new Error('请选择工作树')
          const base = join(projectRoot, ...config.directory.split('/'))
          const target = join(base, ...name.split('/'))
          if (!existsSync(target)) throw new Error('工作树目录不存在：' + target)
          if (!isInside(base, target)) throw new Error('工作树目录越界')
          const entered = await workingDirectory.set(agentOf(body), target)
          json(res, 200, { ok: true, path: entered })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      },
    }))

    routes.push(webServer.register({
      kind: 'exact',
      path: ROUTE + '/worktrees/remove',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只支持 POST' })
          const body = mergeRequest(req, await readBody(req))
          const cwd = directoryOf(body)
          const workspace = await inspectWorkspace(svn, cwd)
          const projectRoot = workspace.kind === 'svn'
            ? dissectWorktreePath(workspace.wcroot, config.directory).projectRoot
            : cwd
          const name = String(body.name ?? '').trim()
          if (name === '') throw new Error('请选择工作树')
          const target = join(projectRoot, ...config.directory.split('/'), ...name.split('/'))
          if (!existsSync(target)) throw new Error('工作树目录不存在：' + target)
          if (!isInside(join(projectRoot, ...config.directory.split('/')), target)) throw new Error('工作树目录越界')
          const current = workspace.kind === 'svn' ? workspace.wcroot : cwd
          if (isInside(target, current)) throw new Error('会话正在使用该工作树，请先切换到其他目录')
          if (body.discard === true) {
            rmSync(target, { recursive: true, force: true })
            json(res, 200, { ok: true, path: target, discarded: true })
            return
          }
          const changes = await readChanges(svn, target, config)
          if (changes.files.length > 0) {
            json(res, 200, { ok: false, error: '工作树还有未提交的改动，请先提交或勾选“丢弃改动”', dirty: changes.files.length })
            return
          }
          rmSync(target, { recursive: true, force: true })
          json(res, 200, { ok: true, path: target, discarded: false })
        } catch (error) {
          json(res, 400, { ok: false, error: error.message })
        }
      },
    }))

    ctx.effect(() => () => { for (const off of routes) off() }, 'svn-worktree: routes')
  })
}

/**
 * Mount the plugin.
 * @param ctx - plugin context.
 * @param config - row config from the Loader.
 */
export function apply(ctx, config) {
  const resolved = settings(config)
  try {
    const clientModules = ctx.get('clientModules')
    if (clientModules !== undefined && typeof clientModules.rebuilt === 'function') clientModules.rebuilt('dsh-svn-worktree')
  } catch { /* client bundle rebuild is best effort */ }
  registerRoutes(ctx, resolved)
  registerTool(ctx, resolved)
  return undefined
}
