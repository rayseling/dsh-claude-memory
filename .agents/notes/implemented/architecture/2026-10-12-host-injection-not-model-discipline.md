# Agent Note: 记忆索引由宿主注入,不靠模型自觉读取

Status: implemented

## Problem

Claude Code 的自动记忆(`~/.claude/projects/<slug>/memory/MEMORY.md`)对 dsh 会话不可见。要让 dsh 里的模型也看到同一份索引,要么让模型自己去读,要么由宿主塞进上下文。

## Decision

dsh-claude-memory 是一个 dsh 插件:在每个会话第一步,由宿主把项目对应的 `MEMORY.md` 确定性注入上下文。Claude Code 自己也是宿主把索引塞进上下文,本插件与之同构。

## Alternatives considered

- **在 `~/.dsh/AGENTS.md` 里写指令,让模型自己跑命令读索引。** 零代码、不依赖宿主接口,是最先尝试的方案。dsh 把工作区指令包装成 "may be relevant / use when applicable",第一次真实会话模型就直接跳过了;依赖模型自觉的方案在这里不可靠。

## Consequences

- 收益:注入是确定性的,与模型无关;模型可见内容走会话事件,可从日志重建。
- 代价:插件依赖 dsh 的 `agent/pre-step`、session header、会话投影三组宿主接口,dsh 改接口时这里要跟([宿主接口清单](../../../../AGENTS.md#代码约定))。
