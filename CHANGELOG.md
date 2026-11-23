# 更新日志

## 0.1.2

- `README.md` 改为中文，成为 GitHub 与 npm 页面上的默认说明；英文说明移到 `README.en.md`，两份顶部互相链接。
- 删除 `README.zh.md`（内容并入 `README.md`），安装与测试段落补充了图形界面安装方式和跨平台路径示例。

## 0.1.1

- 全部源码注释改写为中文文档注释（`lib/index.js`、`client/client.js`、`test/*.mjs`），统一 JSDoc 写法，说明每个函数的参数与返回值。
- 清理插件内的环境相关信息：测试与文档不再写死本机 svn 可执行文件路径、个人邮箱和工作副本路径，改为读取 `PATH` 里的 `svn` / `svnadmin`（可用 `SVN_COMMAND`、`SVNADMIN_COMMAND` 覆盖），真实工作副本检查必须显式传入路径。
- 新增本更新日志。

## 0.1.0

- 首个版本：宿主服务 + 右侧栏「SVN 变更」面板 + 会话头部入口 + `create_svn_worktree` 模型工具。
- 路由：`/state`、`/changes`、`/diff`、`/commit`、`/add`、`/revert`、`/update`、`/worktrees/{create,enter,remove}`、`/health`。
- 新建工作树 = `svn copy` 建分支 + 检出到 `.agents/worktrees/<name>`，随后把会话工作目录切过去。
- 支持 `trunk`/`branches` 布局与「检出整个仓库根目录」两种工作副本。
- 提交使用临时文件传日志（`svn commit -F ... --encoding UTF-8`），中文日志可用。
