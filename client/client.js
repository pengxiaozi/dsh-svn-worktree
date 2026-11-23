/**
 * `dsh-svn-worktree` 的客户端实现。
 *
 * 注册右侧栏页签（「SVN 变更」）以及打开它的会话头部按钮。
 * 面板显示的所有数据都来自 lib/index.js 注册的宿主路由，本文件自己从不执行 svn。
 */
window.__ModuleLoader__.load({
  id: 'dsh-svn-worktree',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-svn-worktree'
    /** 侧栏页签实现 id；同时也是正文与标题插槽的 key。 */
    const TAB_ID = NS
    /** 打开页签时使用的类型标识。 */
    const TAB_KIND = 'svn-worktree'
    const ROUTE = '/dsh-svn-worktree'

    /* ------------------------------------------------------------------ */
    /* 样式                                                               */
    /* ------------------------------------------------------------------ */

    const CSS = `
.svw{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:12px}
.svw-hd{flex:none;display:flex;align-items:center;gap:6px;min-height:36px;padding:0 8px;border-bottom:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.svw-hd-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.svw-url{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}
.svw-rev{font-size:11px;line-height:14px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.svw-body{flex:1;min-height:0;overflow-y:auto;scrollbar-gutter:stable;padding-bottom:8px}
.svw-sec{display:flex;flex-direction:column;gap:2px;padding:8px 8px 4px}
.svw-sec-hd{display:flex;align-items:center;gap:6px;height:24px;color:var(--dsw-alias-label-secondary);font-weight:500}
.svw-sec-hd .svw-count{color:var(--dsw-alias-label-tertiary);font-weight:400}
.svw-sec-hd .svw-spacer{flex:1}
.svw-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.svw-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.svw-btn:disabled{opacity:.45;cursor:default}
.svw-btn.primary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}
.svw-btn.primary:hover:not(:disabled){filter:brightness(1.06);color:#fff}
.svw-btn.danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#d14343)}
.svw-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.svw-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.svw-row{display:flex;align-items:center;gap:6px;min-height:24px;padding:0 4px;border-radius:var(--dsw-radius-xs,4px)}
.svw-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.svw-row.active{background:color-mix(in srgb, var(--dsw-alias-brand-primary,#4d6bfe) 12%, transparent)}
.svw-row.file{cursor:pointer;align-items:flex-start}
.svw-row.file.on{outline:1px solid var(--dsw-alias-border-l4)}
.svw-path{flex:1;min-width:0;font-size:12px;line-height:18px;word-break:break-all;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.svw-row-actions{flex:none;display:none;align-items:center;gap:2px}
.svw-row:hover .svw-row-actions,.svw-row:focus-within .svw-row-actions{display:inline-flex}
.svw-tag{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 4px;border-radius:var(--dsw-radius-xs,4px);font-size:10px;line-height:16px;text-transform:uppercase;letter-spacing:.02em;background:color-mix(in srgb, currentColor 14%, transparent)}
.svw-tag.mod{color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.svw-tag.add{color:var(--dsw-alias-state-success-primary,#2f9e63)}
.svw-tag.new{color:var(--dsw-alias-label-tertiary)}
.svw-tag.del{color:var(--dsw-alias-state-error-primary,#d14343)}
.svw-tag.conflict{color:var(--dsw-alias-state-error-primary,#d14343);font-weight:600}
.svw-check{flex:none;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);cursor:pointer}
.svw-input{flex:1;min-width:0;height:26px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-button-elevated-fill,var(--dsw-alias-bg-layer-1));color:inherit;font-family:inherit;font-size:12px;outline:none}
.svw-input:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.svw-diff{flex:none;margin:4px 8px 8px;max-height:40vh;overflow:auto;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px;white-space:pre;tab-size:4}
.svw-diff .add{color:var(--dsw-alias-state-success-primary,#2f9e63)}
.svw-diff .del{color:var(--dsw-alias-state-error-primary,#d14343)}
.svw-diff .hunk{color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.svw-ft{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px;border-top:.5px solid var(--dsw-alias-border-l4)}
.svw-log{width:100%;box-sizing:border-box;min-height:56px;max-height:160px;resize:vertical;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-button-elevated-fill,var(--dsw-alias-bg-layer-1));color:inherit;font-family:inherit;font-size:12px;line-height:18px;outline:none}
.svw-log:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.svw-ft-row{display:flex;align-items:center;gap:6px}
.svw-ft-hint{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.svw-empty{padding:8px 4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.svw-msg{margin:0 8px 8px;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;word-break:break-all}
.svw-msg.error{color:var(--dsw-alias-state-error-primary,#d14343);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#d14343) 10%, transparent)}
.svw-title{display:inline-flex;align-items:center;gap:6px;min-width:0;font-size:12px}
.svw-title-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4d6bfe)}
.svw-busy{flex:none;width:12px;height:12px;border:1.5px solid var(--dsw-alias-label-tertiary);border-top-color:transparent;border-radius:50%;animation:svw-spin .8s linear infinite}
@keyframes svw-spin{to{transform:rotate(360deg)}}
.svw-hdbtn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;cursor:pointer}
.svw-hdbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
`

    let styleEl = null
    /** 每个窗口只注入一次样式表。 */
    function ensureStyles() {
      if (styleEl !== null && styleEl.isConnected) return
      styleEl = document.createElement('style')
      styleEl.dataset.plugin = NS
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
    }

    /* ------------------------------------------------------------------ */
    /* 多语言文案                                                          */
    /* ------------------------------------------------------------------ */

    const zh = {
      'tab.title': 'SVN 变更',
      'header.button': 'SVN',
      'guide.title': 'SVN 变更',
      'guide.description': '查看工作副本改动、切换工作树并提交',
      'section.worktrees': '工作树',
      'section.changes': '变更',
      'action.refresh': '刷新',
      'action.update': '更新',
      'action.add': '加入版本库',
      'action.revert': '撤销改动',
      'action.commit': '提交',
      'action.enter': '切换到此工作树',
      'action.remove': '删除工作树',
      'action.dismiss': '关闭',
      'action.selectAll': '全选',
      'action.clear': '清空',
      'worktrees.empty': '还没有工作树。创建后会新建 SVN 分支并检出到 .agents/worktrees 下。',
      'worktrees.name': '分支名，例如 fix-login-retry',
      'worktrees.create': '新建工作树',
      'worktrees.enter': '进入',
      'worktrees.discard': '丢弃改动并删除',
      'changes.empty': '工作副本没有改动。',
      'changes.conflicted': '有冲突，请先解决冲突再提交。',
      'changes.truncated': '改动过多，只显示前 {n} 条。',
      'commit.log': '提交日志',
      'commit.logPlaceholder': '说明这次改动做了什么',
      'commit.selected': '已选 {n} 个文件',
      'commit.none': '勾选要提交的文件',
      'commit.done': '已提交，版本 r{rev}',
      'diff.empty': '没有可显示的 diff（可能是二进制文件或属性变更）。',
      'state.notSvn': '当前目录不是 SVN 工作副本：{path}',
      'state.loading': '正在读取工作副本…',
      'error.prefix': '操作失败：',
    }

    const en = {
      'tab.title': 'SVN changes',
      'header.button': 'SVN',
      'guide.title': 'SVN changes',
      'guide.description': 'Review working copy changes, switch worktrees and commit',
      'section.worktrees': 'Worktrees',
      'section.changes': 'Changes',
      'action.refresh': 'Refresh',
      'action.update': 'Update',
      'action.add': 'Add',
      'action.revert': 'Revert',
      'action.commit': 'Commit',
      'action.enter': 'Switch to this worktree',
      'action.remove': 'Remove worktree',
      'action.dismiss': 'Dismiss',
      'action.selectAll': 'Select all',
      'action.clear': 'Clear',
      'worktrees.empty': 'No worktrees yet. Creating one copies a branch and checks it out under .agents/worktrees.',
      'worktrees.name': 'Branch name, for example fix-login-retry',
      'worktrees.create': 'New worktree',
      'worktrees.enter': 'Enter',
      'worktrees.discard': 'Discard changes and remove',
      'changes.empty': 'The working copy has no changes.',
      'changes.conflicted': 'Resolve the conflicts before committing.',
      'changes.truncated': 'Too many changes; showing the first {n}.',
      'commit.log': 'Commit message',
      'commit.logPlaceholder': 'What changed in this commit',
      'commit.selected': '{n} file(s) selected',
      'commit.none': 'Select files to commit',
      'commit.done': 'Committed as r{rev}',
      'diff.empty': 'No diff to show (binary file or property-only change).',
      'state.notSvn': 'This directory is not an SVN working copy: {path}',
      'state.loading': 'Reading the working copy…',
      'error.prefix': 'Failed: ',
    }

    /**
     * 构造带本地字典兜底的翻译函数。
     * @param source - 来自插槽 props 的字典（如果有）。
     * @returns 翻译函数。
     */
    function translator(source) {
      const supplied = typeof source === 'function' ? source : null
      return function translate(key, values) {
        let text = supplied === null ? undefined : supplied(key)
        if (typeof text !== 'string' || text === '') text = undefined
        if (text === undefined) text = zh[key] ?? en[key] ?? key
        if (values !== undefined && values !== null && typeof text === 'string') {
          for (const name of Object.keys(values)) text = text.replaceAll('{' + name + '}', String(values[name]))
        }
        return text
      }
    }

    /* ------------------------------------------------------------------ */
    /* 与宿主通信                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * 调用一个宿主路由。
     * @param path - 插件前缀下的路由路径。
     * @param options - 查询参数、HTTP 方法与 JSON 请求体。
     * @returns 解析后的数据；`ok` 为 false 时抛错。
     */
    async function request(path, options = {}) {
      const query = new URLSearchParams()
      if (options.sessionId) query.set('sessionId', options.sessionId)
      for (const key of Object.keys(options.query ?? {})) {
        const value = options.query[key]
        if (value !== undefined && value !== null) query.set(key, String(value))
      }
      const search = query.toString()
      const response = await fetch(ROUTE + path + (search === '' ? '' : '?' + search), {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        credentials: 'same-origin',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('服务返回了非 JSON 响应（HTTP ' + response.status + '）')
      }
      if (payload === null || payload.ok !== true) {
        throw new Error((payload && payload.error) || 'HTTP ' + response.status)
      }
      return payload
    }

    /* ------------------------------------------------------------------ */
    /* 辅助函数                                                            */
    /* ------------------------------------------------------------------ */

    /** 状态标记的显示信息：CSS 类名与简短标签。 */
    const STATUS = {
      modified: { cls: 'mod', label: 'M' },
      added: { cls: 'add', label: 'A' },
      deleted: { cls: 'del', label: 'D' },
      missing: { cls: 'del', label: '!' },
      replaced: { cls: 'mod', label: 'R' },
      conflicted: { cls: 'conflict', label: 'C' },
      unversioned: { cls: 'new', label: '?' },
      obstructed: { cls: 'del', label: '~' },
      incomplete: { cls: 'conflict', label: 'I' },
      merged: { cls: 'mod', label: 'G' },
    }

    /**
     * 把一条变更记录转换成徽标所需的信息。
     * @param file - 宿主返回的变更记录。
     * @returns CSS 类名与简短标签。
     */
    function describe(file) {
      if (file.conflicted) return STATUS.conflicted
      const known = STATUS[file.status]
      if (known !== undefined) return known
      if (file.props !== 'none' && file.props !== undefined && file.props !== null) return { cls: 'mod', label: 'P' }
      return { cls: 'mod', label: String(file.status ?? '?').slice(0, 1).toUpperCase() }
    }

    /**
     * 把统一差异文本拆成行，并给每行打上着色标记。
     * @param text - 差异文本。
     * @returns `{ cls, text }` 数组。
     */
    function diffLines(text) {
      if (text === undefined || text === null || text === '') return []
      return String(text).split('\n').map((line) => {
        if (line.startsWith('+++') || line.startsWith('---')) return { cls: '', text: line }
        if (line.startsWith('@@')) return { cls: 'hunk', text: line }
        if (line.startsWith('+')) return { cls: 'add', text: line }
        if (line.startsWith('-')) return { cls: 'del', text: line }
        return { cls: '', text: line }
      })
    }

    /* ------------------------------------------------------------------ */
    /* 面板                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 右侧栏面板主体。
     * @param props - 插槽 props 以及注入的服务。
     */
    function SvnPanel(props) {
      const sessionId = props.sessionId
      const t = translator(props.t)
      const [state, setState] = useState(null)
      const [changes, setChanges] = useState(null)
      const [selected, setSelected] = useState(() => new Set())
      const [activePath, setActivePath] = useState(null)
      const [diff, setDiff] = useState(null)
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [name, setName] = useState('')
      const alive = useRef(true)

      useEffect(() => {
        ensureStyles()
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const reload = useCallback(async (quiet) => {
        if (!sessionId) return
        if (!quiet) setBusy('load')
        setError('')
        try {
          const next = await request('/state', { sessionId })
          if (!alive.current) return
          setState(next)
          if (next.workspace && next.workspace.kind === 'svn') {
            const listed = await request('/changes', { sessionId })
            if (!alive.current) return
            setChanges(listed)
            setSelected((previous) => {
              const keep = new Set()
              for (const file of listed.files) if (previous.has(file.path)) keep.add(file.path)
              return keep
            })
          } else {
            setChanges(null)
          }
        } catch (caught) {
          if (alive.current) setError(caught.message)
        } finally {
          if (alive.current && !quiet) setBusy('')
        }
      }, [sessionId])

      useEffect(() => {
        setState(null)
        setChanges(null)
        setSelected(new Set())
        setDiff(null)
        setActivePath(null)
        setNotice('')
        setError('')
        void reload(false)
      }, [reload])

      useEffect(() => { setNotice('') }, [notice])

      /**
       * 执行一次会改动工作副本的操作，然后重新读取。
       * @param label - 运行中显示的文案。
       * @param action - 要执行的操作。
       */
      const act = useCallback(async (label, action) => {
        setBusy(label)
        setError('')
        setNotice('')
        try {
          const result = await action()
          if (result !== undefined && result !== null && typeof result === 'object' && typeof result.message === 'string') {
            setNotice(result.message)
          }
          await reload(true)
          return result
        } catch (caught) {
          if (alive.current) setError(caught.message)
          return null
        } finally {
          if (alive.current) setBusy('')
        }
      }, [reload])

      /**
       * 显示某个路径的差异。
       * @param path - 相对仓库根的路径。
       */
      const preview = useCallback(async (path) => {
        if (activePath === path) { setActivePath(null); setDiff(null); return }
        setActivePath(path)
        setDiff(null)
        try {
          const payload = await request('/diff', { sessionId, query: { path } })
          if (!alive.current) return
          setDiff(payload)
        } catch (caught) {
          if (alive.current) setError(caught.message)
        }
      }, [activePath, sessionId])

      const files = changes === null ? [] : changes.files
      const selectedList = useMemo(() => files.filter((file) => selected.has(file.path)).map((file) => file.path), [files, selected])
      const conflicted = files.some((file) => file.conflicted)
      const commitTargets = useMemo(() => selectedList.filter((path) => {
        const file = files.find((item) => item.path === path)
        return file !== undefined && file.status !== 'unversioned' && file.status !== 'missing' && !file.conflicted
      }), [selectedList, files])
      const addTargets = useMemo(() => selectedList.filter((path) => {
        const file = files.find((item) => item.path === path)
        return file !== undefined && file.status === 'unversioned'
      }), [selectedList, files])

      const toggle = (path) => {
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        })
      }
      const toggleAll = () => {
        setSelected((previous) => previous.size >= files.length ? new Set() : new Set(files.map((file) => file.path)))
      }

      const workspace = state === null ? null : state.workspace
      const isSvn = workspace !== null && workspace !== undefined && workspace.kind === 'svn'
      const worktrees = state === null || !Array.isArray(state.worktrees) ? [] : state.worktrees

      const header = h('div', { className: 'svw-hd' },
        h('div', { className: 'svw-hd-main' },
          h('div', { className: 'svw-url', title: isSvn ? workspace.url : '' }, isSvn ? workspace.relativeUrl : t('tab.title')),
          h('div', { className: 'svw-rev' }, busy === 'load' ? t('state.loading') : (isSvn ? 'r' + String(workspace.revision ?? '?') + (state.current ? ' · ' + state.current : ' · trunk') : '')),
        ),
        busy !== '' ? h('div', { className: 'svw-busy' }) : null,
        h('button', {
          className: 'svw-iconbtn',
          type: 'button',
          title: t('action.refresh'),
          disabled: busy !== '',
          onClick: () => { void reload(false) },
        }, '⟳'),
      )

      const worktreeSection = h('div', { className: 'svw-sec' },
        h('div', { className: 'svw-sec-hd' },
          h('span', null, t('section.worktrees')),
          h('span', { className: 'svw-count' }, String(worktrees.length)),
          h('span', { className: 'svw-spacer' }),
          h('button', {
            className: 'svw-btn',
            type: 'button',
            disabled: busy !== '' || name.trim() === '' || !isSvn,
            onClick: () => {
              const target = name.trim()
              if (target === '') return
              void act('create', async () => {
                const created = await request('/worktrees/create', { sessionId, body: { name: target, enter: false } })
                setName('')
                return { message: '已创建 ' + created.name + ' → ' + created.branchUrl }
              })
            },
          }, t('worktrees.create')),
        ),
        h('div', { className: 'svw-row' },
          h('input', {
            className: 'svw-input',
            value: name,
            placeholder: t('worktrees.name'),
            onChange: (event) => setName(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
          }),
        ),
        worktrees.length === 0
          ? h('div', { className: 'svw-empty' }, t('worktrees.empty'))
          : worktrees.map((worktree) => h('div', {
            key: worktree.path,
            className: 'svw-row' + (state !== null && state.current === worktree.name ? ' active' : ''),
          },
          h('span', { className: 'svw-path', title: worktree.path }, worktree.name),
          h('span', { className: 'svw-tag mod' }, worktree.ok ? 'r' + String(worktree.revision ?? '?') : '?'),
          h('div', { className: 'svw-row-actions' },
            h('button', {
              className: 'svw-btn',
              type: 'button',
              disabled: busy !== '' || (state !== null && state.current === worktree.name),
              title: t('action.enter'),
              onClick: () => {
                void act('enter', async () => {
                  const entered = await request('/worktrees/enter', { sessionId, body: { name: worktree.name } })
                  return { message: '会话工作目录已切换到 ' + entered.path }
                })
              },
            }, t('worktrees.enter')),
            h('button', {
              className: 'svw-btn danger',
              type: 'button',
              disabled: busy !== '',
              title: t('action.remove'),
              onClick: () => {
                void act('remove', async () => {
                  const tried = await request('/worktrees/remove', { sessionId, body: { name: worktree.name } }).catch((caught) => ({ ok: false, error: caught.message }))
                  if (tried.ok === true) return { message: '已删除工作树目录 ' + tried.path }
                  if (/未提交/.test(tried.error || '')) {
                    const confirmed = window.confirm((tried.error || '') + '\n\n' + t('worktrees.discard') + '？')
                    if (!confirmed) return undefined
                    const forced = await request('/worktrees/remove', { sessionId, body: { name: worktree.name, discard: true } })
                    return { message: '已丢弃改动并删除 ' + forced.path }
                  }
                  throw new Error(tried.error || '删除工作树失败')
                })
              },
            }, '✕'),
          ),
        )),
      )

      const changesSection = h('div', { className: 'svw-sec' },
        h('div', { className: 'svw-sec-hd' },
          h('span', null, t('section.changes')),
          h('span', { className: 'svw-count' }, String(files.length)),
          h('span', { className: 'svw-spacer' }),
          h('button', {
            className: 'svw-btn',
            type: 'button',
            disabled: busy !== '' || files.length === 0,
            onClick: toggleAll,
          }, t('action.selectAll')),
          h('button', {
            className: 'svw-btn',
            type: 'button',
            disabled: busy !== '' || !isSvn,
            title: t('action.update'),
            onClick: () => { void act('update', async () => {
              const updated = await request('/update', { sessionId, body: {} })
              return { message: '已更新到 r' + String(updated.revision ?? '?') }
            }) },
          }, t('action.update')),
          h('button', {
            className: 'svw-btn',
            type: 'button',
            disabled: busy !== '' || addTargets.length === 0,
            onClick: () => { void act('add', async () => {
              const added = await request('/add', { sessionId, body: { paths: addTargets } })
              return { message: '已加入版本库 ' + String(added.paths.length) + ' 个文件' }
            }) },
          }, t('action.add')),
          h('button', {
            className: 'svw-btn danger',
            type: 'button',
            disabled: busy !== '' || selectedList.length === 0,
            onClick: () => { void act('revert', async () => {
              const reverted = await request('/revert', { sessionId, body: { paths: selectedList } })
              setSelected(new Set())
              setDiff(null)
              setActivePath(null)
              return { message: '已撤销 ' + String(reverted.paths.length) + ' 个文件' }
            }) },
          }, t('action.revert')),
        ),
        files.length === 0
          ? h('div', { className: 'svw-empty' }, t('changes.empty'))
          : files.map((file) => {
            const badge = describe(file)
            return h('div', {
              key: file.path,
              className: 'svw-row file' + (activePath === file.path ? ' on' : ''),
              onClick: () => { void preview(file.path) },
            },
            h('input', {
              className: 'svw-check',
              type: 'checkbox',
              checked: selected.has(file.path),
              onClick: (event) => event.stopPropagation(),
              onChange: () => toggle(file.path),
            }),
            h('span', { className: 'svw-tag ' + badge.cls }, badge.label),
            h('span', { className: 'svw-path' }, file.path),
            )
          }),
        changes !== null && changes.truncated ? h('div', { className: 'svw-empty' }, t('changes.truncated', { n: files.length })) : null,
        conflicted ? h('div', { className: 'svw-empty' }, t('changes.conflicted')) : null,
      )

      const diffBlock = diff === null
        ? null
        : h('div', { className: 'svw-diff' },
          diff.error !== null && diff.error !== undefined
            ? h('div', { className: 'svw-msg error' }, diff.error)
            : (diff.diff === '' ? h('div', { className: 'svw-empty' }, t('diff.empty'))
              : diffLines(diff.diff).map((line, index) => h('div', { key: String(index), className: line.cls }, line.text === '' ? '\u00a0' : line.text))))

      const footer = h('div', { className: 'svw-ft' },
        h('textarea', {
          className: 'svw-log',
          value: message,
          placeholder: t('commit.logPlaceholder'),
          spellCheck: false,
          onChange: (event) => setMessage(event.target.value),
        }),
        h('div', { className: 'svw-ft-row' },
          h('span', { className: 'svw-ft-hint' },
            commitTargets.length === 0 ? t('commit.none') : t('commit.selected', { n: commitTargets.length })),
          h('button', {
            className: 'svw-btn primary',
            type: 'button',
            disabled: busy !== '' || message.trim() === '' || commitTargets.length === 0 || conflicted,
            onClick: () => { void act('commit', async () => {
              const committed = await request('/commit', { sessionId, body: { message, paths: commitTargets } })
              setMessage('')
              setSelected(new Set())
              setDiff(null)
              setActivePath(null)
              return { message: t('commit.done', { rev: String(committed.revision ?? '?') }) }
            }) },
          }, t('action.commit')),
        ),
      )

      const banner = error !== ''
        ? h('div', { className: 'svw-msg error' }, t('error.prefix') + error)
        : (notice !== ''
          ? h('div', { className: 'svw-msg' }, notice)
          : (state !== null && !isSvn ? h('div', { className: 'svw-msg' }, t('state.notSvn', { path: state.cwd })) : null))

      return h('div', { className: 'svw' },
        header,
        banner,
        h('div', { className: 'svw-body' },
          isSvn ? worktreeSection : null,
          isSvn ? changesSection : null,
          diffBlock,
        ),
        isSvn ? footer : null,
      )
    }

    /**
     * 精简的页签标题。
     * @param props - 插槽 props。
     */
    function SvnTabTitle(props) {
      const t = translator(props.t)
      return h('span', { className: 'svw-title' },
        h('span', { className: 'svw-title-dot' }),
        t('tab.title'),
      )
    }

    /**
     * 打开面板的会话头部按钮。
     * @param props - 插槽 props 以及注入的打开函数。
     */
    function SvnHeaderButton(props) {
      const t = translator(props.t)
      const open = typeof props.openSvnPanel === 'function' ? props.openSvnPanel : () => {}
      return h('button', {
        className: 'svw-hdbtn',
        type: 'button',
        title: t('tab.title'),
        onClick: () => open(),
      }, t('header.button'))
    }

    /* ------------------------------------------------------------------ */
    /* 挂载                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * 注册页签、它的插槽以及头部入口。
     * @param ctx - 客户端插件上下文。
     */
    function apply(ctx) {
      ensureStyles()
      const sidebarRight = ctx.get('sidebarRight')
      const openSvnPanel = () => {
        if (sidebarRight === undefined || sidebarRight === null) return
        try { sidebarRight.openTab(TAB_KIND) } catch { /* tab may be unavailable */ }
      }
      const tr = translator(null)

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'svn-worktree: dictionaries')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => tr('tab.title'),
        guide: [{
          id: 'changes',
          order: 16,
          title: () => tr('guide.title'),
          description: () => tr('guide.description'),
        }],
      }), 'svn-worktree: sidebar tab')

      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
      }, SvnPanel))

      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
        locale: NS,
      }, SvnTabTitle))

      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: NS,
        order: 20,
        locale: NS,
        inject: () => ({ openSvnPanel }),
      }, SvnHeaderButton))
    }

    exports.name = NS
    exports.inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']
    exports.apply = apply
    return module.exports
  },
})
