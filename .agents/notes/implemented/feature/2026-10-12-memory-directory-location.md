# Agent Note: 记忆目录定位:git 根 → linked worktree 的主仓库 → 工作目录,没有工作目录就不注入

Status: implemented

## Problem

Claude Code 的记忆目录 slug 取自仓库根路径(非字母数字字符全换成 `-`)。dsh 会话只给 `header.cwd`,可能缺失;cwd 可能在 linked worktree 里;文档说记忆跨 worktree 共用,但旧版给 worktree 路径单独建过目录。

## Decision

定位顺序:git 根 → linked worktree 的主仓库 → 工作目录;字面路径和真实路径各来一遍。主仓库按 git 自己的 `<gitdir>/commondir` 推:common dir 是某个仓库的 `.git` 目录时取其父目录,否则(`--separate-git-dir`)推不出、放弃。

全部用 fs 判断,不 spawn git;只有 ENOENT/ENOTDIR 算"不存在",其它错误一律抛给 pre-step 去警告,绝不吞成"没有"。

`header.cwd` 缺失就不注入。

## Alternatives considered

- **`header.cwd` 缺失时退回 `process.cwd()`。** 总能得到一个目录。它是 dsh 进程所在的项目(通常是 harness 仓库或 profile),会把别的项目的记忆塞给当前项目,模型无从分辨;宁可不注入。
- **猜 `/.git/worktrees/<name>` 这种目录名来找主仓库。** 不用读 `commondir`。目录布局是 git 的实现细节,`--separate-git-dir` 等配置下不成立;`commondir` 是 git 自己的权威指针。
- **spawn `git rev-parse` 取根。** 最准。每步 pre-step 起一个子进程太重,且 fs 读 `.git` / `commondir` 已足够。

## Consequences

- 收益:主仓库和 worktree 里开的会话读到同一份记忆;旧版按 worktree 路径建的目录也能命中。
- 代价:`--separate-git-dir` 的仓库从 worktree 里定位不到主仓库,只能退到工作目录;权限类错误每会话警告一次而不是静默。
