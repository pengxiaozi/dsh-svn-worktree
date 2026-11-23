# dsh-svn-worktree 使用说明

给 DeepSeek Harness 的 SVN 版「变更 + 工作树」：右侧栏多一个 **SVN 变更** 面板，模型多一个 `create_svn_worktree` 工具。

## 前提

- 会话工作目录本身是 SVN 工作副本（目录里有 `.svn`），否则面板只会提示「当前目录不是 SVN 工作副本」。
- `svn` 命令行可用。DSH 从 `PATH` 里找 `svn`；找不到时在插件配置里写绝对路径：

  ```yaml
  - id: svn-worktree
    name: 'dsh-svn-worktree'
    config:
      svnCommand: 'C:/path/to/svn.exe'
  ```

## 面板里能做什么

打开方式：会话标题栏右侧的 **SVN** 按钮，或在右侧栏标签页列表里选「SVN 变更」。

- **变更列表**：`svn status` 里所有非 normal 的条目，带 M/A/D/?/C 标记；点击某一行看这段改动的 unified diff。
- **勾选 + 提交**：勾选文件、填提交日志、点「提交」。提交走 `svn commit -F <临时日志文件> --targets <临时清单>`，中文日志没问题。
- **加入版本库**：勾选的未受控文件（`?`）先 `svn add`。
- **撤销改动**：勾选项 `svn revert`，未受控文件会被就地删除改动（revert 对 `?` 无效，需自行删除）。
- **更新**：`svn update` 整个工作副本。
- **工作树**：新建 / 进入 / 删除，见下。

## 工作树语义

新建工作树 = **建分支 + 检出**：

1. 取仓库根 URL（`svn info` 的 `Repos root URL`）。
2. 源分支：默认探 `trunk`，不存在则用当前工作副本的 URL；也可以填 `base`（绝对 URL、仓库路径 `/trunk`、或 `branches` 下的分支名）。
3. `svn copy <源> <仓库根>/branches/<name> -m "创建分支 <name>"`。
4. `svn checkout <新分支> <项目根>/.agents/worktrees/<name>`。
5. 勾选「进入」时把会话工作目录切过去（服务端 `workingDirectory.set`）。

两种检出形态都支持：只检出 `trunk`，或检出整个仓库根（`<检出目录>/trunk`、`<检出目录>/branches` 是子目录）。分支目录永远按**仓库根**算，所以从 `trunk` 里新建和从仓库根新建，落在同一个 `branches/<name>`。

删除工作树只删本地检出的目录，**不删远端分支**；工作副本有未提交改动时先报错，确认后才丢弃。

## 提交

勾选文件 → 在底部输入日志 → 「提交」。日志走临时文件（`svn commit -F`），所以中文、多行都没问题；勾选项先落成 `--targets` 清单。提交后面板刷新，列出的都是还没提交的条目。

存在冲突（`C` 标记）时提交会被拒绝。

## 模型工具

```text
create_svn_worktree({ name: "fix-login-retry", base?: "/trunk", enter?: true })
```

返回 `path`、`name`、`branchUrl`、`sourceUrl`、`repositoryRoot`、`revision`。默认会把会话工作目录切到新检出；`enter: false` 只创建不切换。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `svnCommand` | `svn` | svn 可执行文件 |
| `directory` | `.agents/worktrees` | 检出目录，相对项目根 |
| `trunkPath` | `trunk` | 仓库根下的主干路径 |
| `branchesPath` | `branches` | 仓库根下的分支目录 |
| `timeoutMs` | `300000` | copy/checkout/commit 超时 |
| `quickTimeoutMs` | `120000` | status/diff/add/revert 超时 |
| `maxOutputBytes` | `65536` | 单次命令输出上限 |
| `maxDiffBytes` | `200000` | diff 文本上限 |
| `maxFiles` | `500` | 变更列表条数上限 |
| `copyMessage` | `创建分支 {name}` | `svn copy` 的日志模板 |

## 已知边界

- 面板只读**会话工作目录**这一个工作副本；切到别的工作树后需点「刷新」。
- 没有 PR 概念，所以不注册 forge 变更请求提供者；提交就是直接进 trunk/分支。
- 冲突（`C`）会阻止提交，需要先在外部解决并 `svn resolve`。
- 二进制文件的 diff 由 svn 自己决定，可能只显示一行说明。

## 自测

```bash
node test/host.test.mjs      # 临时仓库，覆盖两种检出形态与全部路由
node test/client.test.mjs    # 前端模块的加载、注册与渲染
node test/check-real-copy.mjs D:\path\to\working-copy   # 对真实工作副本只读体检
```
