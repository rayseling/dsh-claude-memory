# Agent Note: 注入消息是 `user/message` 事件,来源 `plugin:claude-memory`,form `snapshot`

Status: implemented

## Problem

注入的索引必须随会话日志重放、压缩、续聊,满足 dsh 的"model-visible ⟺ logged"规则;同时要让消费者知道它是插件产物而不是用户输入。

## Decision

注入走 `@deepseek-ai/dsh-llm` 的 `createUserMessage`,落成 `user/message` 事件,`kind: 'plugin:claude-memory'`,`form: 'snapshot'`。

来源 `kind` 固定为 `plugin:claude-memory`:V4 迁移给第三方生产者的约定就是 `plugin:<name>`(first-party 才用裸名),已落盘的会话也用它。它与事件类型命名空间 `plugin:<record>` 同形但是不同字段。

## Alternatives considered

- **`kind: 'plugin'`。** 更短,早期草稿这么写。V4 格式拒绝这种旧写法,不可用。
- **裸名 `claude-memory`。** 与 first-party 事件同形。V4 把裸名留给 first-party,第三方必须带 `plugin:` 前缀。

## Consequences

- 收益:注入内容可从日志完整重建;压缩后由[投影](2026-10-12-dedup-state-in-session-projection.md)触发重新注入。
- 代价:`kind` 已随会话落盘,永远不能改名。
- `form: 'snapshot'` 只是给消费者的语义,宿主不会删旧消息——由此派生的[替代与撤回语义](../feature/2026-10-12-snapshot-replacement-and-withdrawal.md)另有记录。
