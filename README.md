# dsh-svn-worktree

DeepSeek Harness 的 SVN 版「变更 + 工作树」插件：右侧栏多一个 **SVN 变更** 面板，模型多一个 `create_svn_worktree` 工具，工作树用 `svn copy` + `svn checkout` 实现。

[English](README.en.md) · 完整用法见 [docs/usage.md](docs/usage.md) · 更新记录见 [CHANGELOG.md](CHANGELOG.md)

## 能力

- 列出会话工作目录的改动（`svn status`），点击任一条查看该文件的 unified diff。
- 勾选文件、自己写提交日志后提交（`svn commit -F <日志> --targets <清单>`），中文日志可以直接用。
- 把未纳入版本控制的文件加入版本库、撤销改动、更新工作副本。
- 创建工作树：从 `trunk`（或指定 base）复制到 `<仓库根>/branches/<name>`，再检出到 `<项目根>/.agents/worktrees/<name>`，可选把会话工作目录切过去。

## 安装

```text
plugin_manager install_bundle  target: <本目录绝对路径>
```

也可以直接引用 GitHub / npm 上的包：

```text
plugin_manager install_bundle  target: github:pengxiaozi/dsh-svn-worktree
plugin_manager install_bundle  target: dsh-svn-worktree
```

也可以走图形界面：插件 → 添加插件 → 填 `dsh-svn-worktree@0.1.2` 或包目录路径。

装好后在会话标题栏点 **SVN** 按钮，或到右侧栏标签里选「SVN 变更」。插件页展示的标题与描述在 `locale/en.json`、`locale/zh.json`。

## 前提

- 会话工作目录本身是 SVN 工作副本（目录里有 `.svn`），否则面板只会提示「当前目录不是 SVN 工作副本」。
- `PATH` 里有 `svn` 可执行文件；找不到时在插件配置里把 `svnCommand` 指到绝对路径：

  ```yaml
  - id: svn-worktree
    name: 'dsh-svn-worktree'
    config:
      svnCommand: 'C:/path/to/svn.exe'
  ```

## 文件

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主：svn 调用、工作副本探测、`/dsh-svn-worktree` 路由、`create_svn_worktree` 工具 |
| `client/client.js` | 前端：右侧栏面板、标签标题、会话标题栏按钮 |
| `locale/*.json` | 插件页标题、描述、说明文档链接 |
| `docs/usage.md` | 行为、工作树语义、配置项 |
| `test/host.test.mjs` | 用临时本地 SVN 仓库跑宿主端到端测试 |
| `test/client.test.mjs` | 用极简 React 替身挂载前端模块，确认注册与渲染不抛异常 |
| `test/check-real-copy.mjs` | 对真实工作副本做只读体检：`node test/check-real-copy.mjs <路径>` |

## 测试

```bash
node test/host.test.mjs
node test/client.test.mjs
node test/check-real-copy.mjs /path/to/working-copy
```

`host.test.mjs` 用 `svnadmin` 建临时仓库，覆盖两种检出形态：只检出 `trunk`，以及检出整个仓库根（`trunk`／`branches` 是子目录，生产上更常见）。然后把每条路由都跑一遍：state、changes、diff、add、commit、工作树创建／进入／删除，以及各种应当失败的边界情况。

`client.test.mjs` 按浏览器的模块加载契约载入 `client/client.js`，用替身 React 渲染标签体、标签标题和标题栏按钮，只保证不抛异常；面板的真实观感仍需在应用里点开看。

`test/check-real-copy.mjs` 需要你显式给出工作副本路径，只走只读路由，不改动任何文件。

## 边界

- 除你主动触发的 add / revert / update / commit 外，对仓库只读。
- 不注册变更请求提供者：SVN 没有 PR 概念，面板只做本地变更与分支工作树。
- 有冲突时禁止提交，需在面板外用 `svn resolve` 解决。
- 删除工作树只删本地检出，不会删除远端分支。

## 许可

MIT
