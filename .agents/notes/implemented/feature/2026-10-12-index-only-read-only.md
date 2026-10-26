# Agent Note: 只注入索引、条目按需读,插件对记忆只读

Status: implemented

## Problem

记忆目录里除了索引 `MEMORY.md` 还有若干条目文件。注入多少、谁维护它们,决定了上下文占用和与 Claude Code 行为的一致性。

## Decision

与 Claude Code 完全一致:只注入索引,上限 200 行 / 25,000 UTF-16 code unit(文档写 25KB,claude-code#97453 实测为 code unit,未被维护者确认),先到为准;截断永远落在完整字符边界,首行超限时给前缀。条目文件不预加载,注入文本告诉模型只在相关时 `cat`。

插件对 `~/.claude` 永远只读:不创建、不修改、不删除任何文件;注入文本也要求模型不这么做。那里的记忆由 Claude Code 维护。dsh 会话自己学到的事写进另一个目录,见 [dsh 自己的记忆目录](2026-10-26-own-memory-store.md);同样的索引上限和按需 `cat` 规则对它一并适用。

## Alternatives considered

- **加检索层(memsearch 一类),按问题相关度挑条目注入。** 看起来比裸索引精准。Claude Code 本身没有检索,索引里的一行钩子就是检索;加一层会让两边行为分叉,也引入新依赖。
- **预加载条目文件。** 省去模型一次 `cat`。条目总量无上限,会撑爆上下文,Claude Code 也不这么做。
- **让插件写记忆或做摘要。** 两个宿主共用一份记忆时双写会冲突;单一写者(Claude Code)最简单。这一条只约束 Claude Code 的目录;dsh 自己的目录由模型写,插件进程仍不写文件。

## Consequences

- 收益:上下文占用有硬上限,行为与 Claude Code 可逐条对照。
- 代价:Claude Code 改了上限或截断规则,这里要同步改默认值(走 `Config`,默认值就是 Claude Code 的值)。
- 不做的事:插件进程不写文件、不做摘要、不做检索;UI 只有会话开关。
