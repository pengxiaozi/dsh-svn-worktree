# dsh-svn-worktree

SVN version of the change panel and worktree feature for DeepSeek Harness: a **SVN changes** tab in the right sidebar, a `create_svn_worktree` tool for the model, and branch worktrees backed by `svn copy` + `svn checkout`.

Chinese documentation: [README.zh.md](README.zh.md) · Usage details: [docs/usage.md](docs/usage.md)

## What it does

- Lists the working copy changes of the Session directory (`svn status`), with per-file unified diffs.
- Commits the selected files with a message of your own (`svn commit -F <log> --targets <list>`).
- Adds unversioned files, reverts changes, updates the working copy.
- Creates worktrees: copies a branch from `trunk` (or the given base) to `<repos-root>/branches/<name>` and checks it out under `<project>/.agents/worktrees/<name>`, optionally switching the Session directory to it.

## Install

```text
plugin_manager install_bundle  target: <path to this directory>
```

Or straight from GitHub / npm:

```text
plugin_manager install_bundle  target: github:pengxiaozi/dsh-svn-worktree
plugin_manager install_bundle  target: dsh-svn-worktree
```

Then open the **SVN** button in a Session header, or pick **SVN changes** in the right sidebar tab list. Plugin page metadata lives in `locale/en.json` and `locale/zh.json`.

## Requirements

- The Session working directory must be an SVN working copy.
- An `svn` executable on `PATH`; set `svnCommand` in the plugin config when it is elsewhere.

## Files

| Path | Role |
| --- | --- |
| `lib/index.js` | Host: `svn` runner, workspace detection, routes under `/dsh-svn-worktree`, `create_svn_worktree` tool |
| `client/client.js` | Web: right-sidebar tab, tab title, Session header button |
| `locale/*.json` | Plugins page title, description and detail link |
| `docs/usage.md` | Behaviour, worktree semantics, configuration |
| `test/host.test.mjs` | End-to-end host test against a throwaway local SVN repository |
| `test/client.test.mjs` | Mounts the client module with a stand-in React to prove registration and rendering |
| `test/check-real-copy.mjs` | Read-only check against a real working copy: `node test/check-real-copy.mjs <path>` |

## Test

```bash
node test/host.test.mjs
node test/client.test.mjs
node test/check-real-copy.mjs D:\path\to\working-copy
```

`host.test.mjs` creates a local repository with `svnadmin` and covers both checkout layouts: `trunk` checked out on its own, and the repository root checked out with `trunk`/`branches` as subdirectories, which is the more common production shape. It then drives every route: state, changes, diff, add, commit, worktree create/enter/remove and the refusals around them.

`client.test.mjs` loads `client/client.js` through the browser module contract and renders the tab body, tab title and header button with a stand-in React. It only proves nothing throws; the panel still has to be looked at in the app.

## Boundaries

- Read-only towards the repository except for the explicit add/revert/update/commit actions you trigger.
- No change-request provider: SVN has no pull-request concept.
- Conflicts block commits; resolve them with `svn resolve` outside the panel.
- Removing a worktree never deletes the remote branch.
