# Agent Note: 会话级 memory 开关

Status: implemented

## Problem

插件在每个会话第一步自动注入项目索引,没有会话级选择。想只让某个会话不加载或更新记忆,只能改 profile 配置或卸载插件,这对同一 dsh 进程里的其他会话也生效。需要一个每会话独立、默认打开、普通续聊后仍保持的开关。

## Decision

`/memory on|off|status` 命令控制当前会话的开关,默认 `on`。

- 命令只在有交互 command adapter 的 Web 客户端可用;shipped headless/ACP 有 `commands` 服务但没有 adapter,注册了也无法派发,插件仍正常注入。命令用稳定 `definitionId: 'dsh-claude-memory'` 注册;client 分发前用 `remote.commands.list` 确认当前生效的同名命令仍属于本插件,名字被占用/遮蔽时不动手。
- 开关状态放进独立的 `claudeMemoryMode` 会话投影,不放进 [`claudeMemory` 的去重状态](../architecture/2026-10-12-dedup-state-in-session-projection.md)。命令 handler 校验参数后 `appendPluginRecord(session, 'plugin:claude-memory/mode', { enabled })`;投影只折叠这条带 `ignorable: true` 的记录。surface 替换和压缩不会碰它,所以不会被重置成 `on`。
- `agent/pre-step` 在 `step === 1` 先读开关;`off` 直接返回,不 stat、不读、不注入、不撤回。重新 `on` 后按当时的索引和 digest 正常注入:期间变过就进新 snapshot;没变且旧 snapshot 仍在 surface 上就什么都不做(压缩把它移走后会重注)。
- 开关关闭不删除已经注入的索引,也不补提示。它回答的是"这个会话先别加载或更新记忆",不是"让模型忘掉已经看过的记忆";这与 [snapshot 替代语义](2026-10-12-snapshot-replacement-and-withdrawal.md) 的分工一致。
- 命令在一条 turn 的 pre-step 已经返回之后到达时,只影响下一轮;它不撤回本轮已经注入的消息。
- 开关按会话保存,普通续聊时由投影重放 `plugin:claude-memory/mode` 记录恢复;fork 会继承记录,因此也继承开关。
- 子代理仍按 [默认不注入](2026-10-12-subagents-not-injected-by-default.md) 处理,开关不改变这一点。

## Client half

同一个包也声明 `dsh.client`(`platform: web`,inject `api-remotes` / `api-session-controller` / `client-locale` / `client-ui-conversation`),`exports["./client"]` 指向手写的 `src/client.js`。该文件是 `window.__ModuleLoader__.load({ id, factory })` 闭包,没有构建步骤;factory 只 `require('react')`,在 `conversation.input.right`(模型选择前的紧凑控件行)注册 `MemoryPill`,通过 `ctx.remote.commands.execute` 执行 `/memory on|off`。client 插件 inject `slots`/`remote`/`remote.commands`/`sessions`/`locale`;`sessions.subagentAddress(sessionId)` 非空时 pill 不渲染;执行前用 `remote.commands.list` 校验 `definitionId`,避免 `/memory` 被同名命令遮蔽时触发别的插件。

- 服务端 mode 投影新增 `wire: { viewSchema, view }`,客户端从 `useProjection('claudeMemoryMode')` 读 `{ enabled }`;view 缺失时 pill 不渲染。
- pill 文案走 client locale(namespace `claude-memory`),order 0;命令结果 `value.result.kind === "error"` 时把错误文本显示出来,不再当作成功。
- 组件在会话或开关变化时清空 busy/error;异步回调检查组件存活和请求 token,避免旧结果覆盖新会话。
- `test/client.test.js` 用假 `__ModuleLoader__` / React / ctx 驱动闭包、slot 注册、命令执行、handler/传输错误、命令归属冲突、subagent 可用性和 on/off 标签。

## Testing

`test/plugin.test.js` 覆盖:开关投影的默认值、折叠、wire view 与忽略 surface 替换,`/memory` 参数解析、命令注册与注册失败、命令写入成功与抛出异常、重复开关不追加记录,关闭后不注入不刷新、中途关闭不注入,压缩后仍保持关闭,重新打开后注入变化后的索引、索引未变不重注、索引删除则撤回;另有一条真实 `SessionProjectionRegistry` 测试,验证 live drive、`ignorable` 标记和从 seed 日志恢复。`test/client.test.js` 用假 loader/React 驱动 client 闭包、slot 注册、命令执行、handler/传输错误、subagent 可用性和 on/off 标签。`npm test` 全部通过。

## Alternatives considered

- **profile 级 `enabled` 或直接移除插件行。** 最简单,但作用于整个 profile,不能只关一个会话。
- **一次性关闭(只关下一轮)。** 省一次"记得开回来",但要在拒绝、续聊、压缩、并发下消费一次性状态;用户明确只需要持久开关,收益不值得这些边界。
- **关闭时追加一条"忽略旧索引"的提示。** 用户要的是停止加载或更新,不是让模型忘掉已展示内容。提示会多一条模型可见消息,还会让重新打开时必须重注整份索引;不采纳。
- **把开关写进现有 `claudeMemory` 投影。** 该投影在 surface 替换时整体清空,会把 `off` 重置成 `on`;拆成独立投影更稳。
- **解析 `command/run` 事件来更新开关。** 命令在附件校验之前就写入 `command/run`,一次被拒绝的 `/memory off` 也会改状态;由 handler 在参数和附件校验通过后 append 专用记录更准确。
- **用 `session.append` 写自定义事件。** `session.append` 不写 `ignorable` 标记,而持久化读取只接受已知事件类型或带该标记的记录;续聊会拒绝整条日志。改用 `appendPluginRecord`,记录带 `ignorable: true`,旧 reader 会保留并跳过。
- **只保留斜杠命令,不做 pill。** 少一个 client 面;但用户要在 composer 上看到并切换,命令不够直观,故在同一个包里加了手写 client pill。
- **拆独立 `dsh-claude-memory-ui` 包。** 核心包可保持无 client、UI 可独立发版;但要多装一个包、维护 client 包清单,而这里 UI 很小,放同一包更省。
- **用 tsdown 构建 client bundle。** 能拿 CSS modules、HMR 和 source map;但本仓库是纯 ESM 无构建,手写闭包只依赖 loader 契约,当前 UI 足够小,先不引入工具链。

## Consequences

- 收益:同一 dsh 进程里可以按会话关闭记忆,不需要改 profile;关闭后连磁盘 stat 都不做。
- 代价:server 新增两个宿主接口——可选的 `commands` 注册和 `appendPluginRecord('plugin:claude-memory/mode')`;后者让 `@deepseek-ai/dsh-session`(>= 0.2.1-alpha.2)成为 peer 依赖;更旧的宿主只记一条警告、不注册 `/memory`,注入继续。client 半用 `slots`/`remote`/`remote.commands`/`sessions`/`locale`,并让 `dsh.client` 进入 web 构建。命令名 `memory` 若与别的插件冲突,注册失败只记警告,注入继续,但该会话无法切换。
- 关闭前已经注入的索引仍在模型上下文里;要真正无记忆,应在会话第一轮前关闭,或使用不装插件的 profile/preset。
- shipped headless/ACP 没有命令 adapter,或宿主缺少 `appendPluginRecord` 时只能保持默认 `on`;后者加载时记警告。
- 宿主对 plugin record 的格式迁移是 best-effort:普通续聊、fork、压缩会携带该记录,迁移若丢失它,开关回到默认 `on`。
- peer 范围 `>=0.2.1-alpha.2` 按 semver 只匹配同 patch 的预发布版;后续 patch 的 alpha/beta 可能被 pnpm 判为不满足,正式版不受影响。
- client 改动没有构建/HMR,改完要重启 profile:web;`dsh.client` 指向的 `src/client.js` 缺失或语法错误会让 web 客户端加载失败。
- 每次点 pill 都走一次 `/memory on|off` 命令,会话日志会留下 `command/run`、`command/done`,界面可能显示一条命令记录;这是宿主命令面的既有行为。
- `conversation.input.right` 不传 `locked`;removed/inert 会话上的 pill 仍可点,失败文本会显示在 pill 旁。subagent 会话已由 `sessions.subagentAddress` 隐藏。
- 若 `/memory` 已被别的插件占用或按 agent 遮蔽,client 的命令归属检查会失败,不会执行别人的同名命令;pill 仍可见,可能显示错误。
- pill 读 `wire` view;旧 server 不提供该 view 时 pill 不出现,斜杠命令仍可用。
