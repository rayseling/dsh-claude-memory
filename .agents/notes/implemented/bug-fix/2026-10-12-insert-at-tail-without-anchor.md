# Agent Note: 插入位置找不到锚点就放尾部

Status: implemented

## Problem

注入的 snapshot 要排在用户当轮消息之后。pre-step 用 `findLastIndex` 找最后一条用户消息作锚点,但上游监听器可能把 claimed 消息换成副本,锚点找不到时 `findLastIndex` 得 -1。

## Decision

锚点得 -1 时把 snapshot 追加到消息列表尾部。

## Alternatives considered

- **-1 时按下标 0 插入。** 代码最短(`splice(index + 1)`)。会把索引排到用户提问前面,模型先看到记忆再看到问题,顺序与正常路径相反。

## Consequences

- 收益:锚点缺失时顺序仍是"问题在前、索引在后"。
- 代价:无。
