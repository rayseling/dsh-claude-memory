# Agent Note: snapshot 的替代语义、摘要去重与撤回

Status: implemented

## Problem

`form: 'snapshot'` 只是给消费者的语义,宿主不会删旧消息:新 snapshot 注入后,旧的仍留在模型上下文里。索引在会话中途可能变化、消失或读不到,每种情况模型看到的都必须是"现状"。

## Decision

- 注入文本写明"这是完整的当前索引,替代此前展示过的",否则被删掉的条目还会被模型当成存在。
- 摘要(digest)相同不注入;不同就注入新 snapshot 覆盖。
- 记忆消失要撤回:展示过的索引文件不见了(stat 得 ENOENT/ENOTDIR)或变空,注入一条撤回 snapshot;它同样带 digest,所以只进一次。两个存储合成一条消息后,撤回只在没有任何一段可展示时发生;[dsh 自己的段](2026-10-26-own-memory-store.md) 开着就始终存在,Claude Code 索引消失只是下一条替代消息少一段。
- 读不到不算消失:读失败、stat 得其它错误(EACCES/EIO)说明不了内容。`currentIndex` 用判别式 `kind: 'text' | 'blank' | 'error'` 区分;error 不缓存、不撤回、每会话只警告一次。

## Alternatives considered

- **依赖宿主删除旧 snapshot。** 最省事。宿主没有这个行为,`form` 只是语义标记。
- **冷缓存时对比加一次抖动,再决定是否撤回。** 想避免瞬时读失败触发撤回。0.2.0 这么做过,反而造出了假撤回;改为按错误类型判别后不需要抖动。

## Consequences

- 收益:模型上下文里任何时刻都有一份自称"当前完整"的索引;索引被删后模型不会继续引用旧条目。
- 代价:每次索引内容变化都多一条 `user/message` 进日志;读失败场景只能警告,模型会继续用上一份已展示的索引。
- 事件形态见[注入消息事件](../architecture/2026-10-12-snapshot-user-message-event.md);"已展示"的判定来自[会话投影](../architecture/2026-10-12-dedup-state-in-session-projection.md)。
