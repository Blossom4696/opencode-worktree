---
description: Create a git worktree directly
---
Create a git worktree without relying on model tool selection.

Usage: `/worktree-create <branch> [baseBranch]`

路径策略：worktree 目录创建在当前仓库同级目录，默认目录名为 `<仓库名>-<branch>`。

`ctrl+p` 新入口 `Worktree session (ctrl+p)` 与本命令共享同一路径策略。
