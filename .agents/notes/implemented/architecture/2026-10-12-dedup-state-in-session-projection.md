# Agent Note: 去重状态放在会话投影里,不扫历史

Status: implemented

## Problem

每步 pre-step 都要判断"当前索引是否已经注入过、是否仍在模型可见的 surface 上",否则会重复注入或在压缩后漏注入。判断依据是会话历史,而 dsh 已弃用同步读历史的接口。

## Decision

用 `ctx.sessionProjections.register` 注册 `claudeMemory` 投影:纯折叠,记录本插件最新一条在 surface 上的 snapshot 的 seq/digest/path。`user/message` 命中时更新;`surfaceOp.op === 'replace'` 且事件的 `sourceEventSeqs` 包含该 seq 时清空(宿主要求替换事件列出每个被遮蔽节点),压缩后因此会重新注入。pre-step 只读 `stateOf`。

`stateSchema` 是手写的 `{ parse }`。改了状态字段或折叠语义必须 bump `stateVersion`。

## Alternatives considered

- **`Session.eventAt` / `snapshotEvents` / `ownEvents` 扫历史。** 直接、无状态。dsh 已弃用并禁止新增调用(dsh agents note 2026-09-09),不可用。
- **按 `startSeq..endSeq` 区间判断是否被替换。** 不依赖 `sourceEventSeqs`。surface 顺序不保证 seq 递增,区间判断会误判;只在替换事件没带 source 列表时兜底。
- **用 zod 定义 `stateSchema`。** 更省写。只为一个小对象引入依赖不值;手写 `{ parse }` 够用。

## Consequences

- 收益:判断是 O(1) 读投影状态,不随会话变长而变慢;压缩后自动重新注入。
- 代价:投影状态随会话持久化,字段或语义一变就要 bump `stateVersion`,否则旧会话续聊会读到错误状态。
- 事件形态见[注入消息事件](2026-10-12-snapshot-user-message-event.md)。
