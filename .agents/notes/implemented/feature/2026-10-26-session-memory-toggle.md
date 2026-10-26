# Agent Note: 会话级按来源的记忆读取开关

Status: implemented

## Problem

插件在每个会话第一步自动注入项目索引,没有会话级选择。想只让某个会话不加载或更新记忆,只能改 profile 配置或卸载插件,这对同一 dsh 进程里的其他会话也生效。需要一个每会话独立、普通续聊后仍保持的开关;默认位置由 profile 决定。记忆有多个来源(Claude Code 的索引、[dsh 自己的目录](2026-10-26-own-memory-store.md),将来可能还有别的 harness 的),用户要按来源分别决定读不读;写记忆不是会话级选择。

## Decision

`/memory <source> on|off`(`claude` / `dsh`)控制当前会话读哪些来源,`/memory status` 回显,裸 `/memory on|off` 作用于全部来源;没切换过的来源取配置 `readByDefault`,默认 `{ claude: false, dsh: true }`。写记忆不受开关影响:只要配置了 `ownMemory`,自己的段(目录与写入规则)始终注入,`dsh` 读关着时该段只说"索引未加载,写前先读",不读索引内容。

- 来源列表是 `SOURCES = ['claude', 'dsh']`,投影状态、命令语法、wire view、client 行都从它派生;加一个来源只需在 `SOURCES`、`readByDefault` 和 `currentStores` 各加一处。
- 投影状态是 `{ read: { [source]: boolean } }`,只记用户明确切换过的来源;缺键的来源在读取时由 `config.readByDefault` 解析(`resolveRead`),不写进状态。这样改 profile 默认值,所有没切换过的会话(含已有投影 checkpoint 的)立即跟随。状态里不认识的来源 id 原样保留,以后加来源不作废旧 checkpoint。wire view 发给 client 的是 `{ sources: [{ id, enabled }] }`,每个来源解析后的位置,client 不需要知道默认值。
- 0.3.0/0.4.0 写下的记录是 `{ enabled }`、没有 `source`,当年只有 Claude Code 一个来源,折叠时按 `claude` 处理;`stateVersion` 2 → 3,旧 checkpoint 丢弃后从日志重算。
- `readByDefault` 与 `ownMemory*` 是本插件不取 Claude Code 默认值的配置项:Claude Code 始终加载自己的索引,用户要求 dsh 会话默认只读自己的、Claude Code 的按需打开。

- 命令只在有交互 command adapter 的 Web 客户端可用;shipped headless/ACP 有 `commands` 服务但没有 adapter,注册了也无法派发,插件仍正常注入。命令用稳定 `definitionId: 'dsh-claude-memory'` 注册;client 分发前用 `remote.commands.list` 确认当前生效的同名命令仍属于本插件,名字被占用/遮蔽时不动手。
- 开关状态放进独立的 `claudeMemoryMode` 会话投影,不放进 [`claudeMemory` 的去重状态](../architecture/2026-10-12-dedup-state-in-session-projection.md)。命令 handler 校验参数后,对每个位置要变的来源 `appendPluginRecord(session, 'plugin:claude-memory/mode', { source, enabled })`,位置已经相同的不追加;投影只折叠这种带 `ignorable: true` 的记录。surface 替换和压缩不会碰它,所以不会被重置。
- `agent/pre-step` 在 `step === 1` 先解析各来源的开关;`claude` 关着就不定位、不读 Claude Code 索引;`dsh` 关着就不读自己的索引;两个都关且没配 `ownMemory` 时直接返回,不 stat、不注入、不撤回。注入前再解析一次,中途变过就本轮放弃。重新打开后按当时的索引和 digest 正常注入:期间变过就进新 snapshot;没变且旧 snapshot 仍在 surface 上就什么都不做(压缩把它移走后会重注)。
- 关掉一个来源不删除已经注入的索引,也不补提示;下一条替代消息里少了那一段,"完整替代此前索引"的声明已经覆盖。它回答的是"这个会话先别加载或更新这个来源",不是"让模型忘掉已经看过的记忆";这与 [snapshot 替代语义](2026-10-12-snapshot-replacement-and-withdrawal.md) 的分工一致。
- 命令在一条 turn 的 pre-step 已经返回之后到达时,只影响下一轮;它不撤回本轮已经注入的消息。
- 开关按会话保存,普通续聊时由投影重放 `plugin:claude-memory/mode` 记录恢复;fork 会继承记录,因此也继承开关。
- 子代理仍按 [默认不注入](2026-10-12-subagents-not-injected-by-default.md) 处理,开关不改变这一点。

## Client half

同一个包也声明 `dsh.client`(`platform: web`,inject `api-remotes` / `api-session-controller` / `client-locale` / `client-ui-conversation`),`exports["./client"]` 指向手写的 `src/client.js`。该文件是 `window.__ModuleLoader__.load({ id, factory })` 闭包,没有构建步骤;factory 只 `require('react')`,在 `conversation.input.right`(模型选择前的紧凑控件行)注册 `MemoryMenu`:一个"记忆"按钮,点开一个菜单,view 里每个来源一行、各自一个开关,点一行就通过 `ctx.remote.commands.execute` 执行 `/memory <source> on|off`。按钮文字列出正在读的来源("记忆: DSH + Claude Code"),都关着显示"记忆:关"。行从 view 派生,服务端加来源 client 不用改;来源名走 locale 键 `source.<id>`,没有译文时 locale 回退显示键名本身。client 插件 inject `slots`/`remote`/`remote.commands`/`sessions`/`locale`;`sessions.subagentAddress(sessionId)` 非空时不渲染;执行前用 `remote.commands.list` 校验 `definitionId`,避免 `/memory` 被同名命令遮蔽时触发别的插件。

- 服务端 mode 投影的 `wire: { viewSchema, view }` 发 `{ sources: [{ id, enabled }] }`,客户端从 `useProjection('claudeMemoryMode')` 读;view 缺失时不渲染。
- 文案走 client locale(namespace `claude-memory`),order 0;命令结果 `value.result.kind === "error"` 时把错误文本显示出来,不当作成功。
- 组件在会话或任一来源变化时清空 busy/error,换会话时收起菜单;异步回调检查组件存活和请求 token,避免旧结果覆盖新会话。
- `test/client.test.js` 用假 `__ModuleLoader__` / React / ctx 驱动闭包、slot 注册、命令执行、handler/传输错误、命令归属冲突、subagent 可用性、按钮文字、菜单行(含 view 里未知的来源 id)和每行发出的命令。

## Testing

`test/plugin.test.js` 覆盖:开关投影的未设置状态、`readByDefault` 下的 wire view 与命令回显、默认只读 dsh 直到 `/memory claude on`、按来源折叠、0.4.0 记录按 `claude` 折叠、未知来源保留、忽略 surface 替换,`/memory` 参数解析(状态、单来源、裸 on/off、非法输入)、命令注册与注册失败、命令按变动的来源各追加一条记录、位置相同不追加、写入抛出异常,关闭后不注入不刷新、中途关闭不注入,压缩后仍保持关闭,重新打开后注入变化后的索引、索引未变不重注、索引删除则撤回,`dsh` 读关着时仍注入目录与规则但不读索引、两个都关且无 own store 时不注入、中途关 `claude` 只少一段不撤回;另有一条真实 `SessionProjectionRegistry` 测试,验证 live drive、`ignorable` 标记和从 seed 日志恢复。`npm test` 全部通过。

## Alternatives considered

- **profile 级 `enabled` 或直接移除插件行。** 最简单,但作用于整个 profile,不能只关一个会话。
- **一次性关闭(只关下一轮)。** 省一次"记得开回来",但要在拒绝、续聊、压缩、并发下消费一次性状态;用户明确只需要持久开关,收益不值得这些边界。
- **关闭时追加一条"忽略旧索引"的提示。** 用户要的是停止加载或更新,不是让模型忘掉已展示内容。提示会多一条模型可见消息,还会让重新打开时必须重注整份索引;不采纳。
- **默认值写进投影初始状态(`init: () => ({ read: config.readByDefault })`)。** 更直接,但投影 checkpoint 会把初始状态存下来,之后改配置对已有会话不生效;而且分不清"用户选了 on"和"默认是 on"。改为状态只存明确选择、读时解析。
- **一个四档下拉(关 / dsh / Claude Code / 两者)。** 一次点选就到位,和模型选择器形态一致。来源一多档位呈指数增长,第三个来源就是八档;用户要的是每个来源各自开关、以后加 harness 记忆还能在同一个面板里选,所以做成一行一个开关的菜单。
- **写记忆也做成开关。** 对称,也能让某个会话"只读不写"。用户定了写记忆是必须的,只允许在配置文件里用 `ownMemory: false` 关;会话里少一个要理解的状态。
- **`dsh` 读关着时连自己的目录也不提。** 消息更短。模型就不知道往哪写,等于把写也关了;改为只省掉索引内容、保留目录和规则,并要求写前先读索引去重。
- **把开关写进现有 `claudeMemory` 投影。** 该投影在 surface 替换时整体清空,会把 `off` 重置成 `on`;拆成独立投影更稳。
- **解析 `command/run` 事件来更新开关。** 命令在附件校验之前就写入 `command/run`,一次被拒绝的 `/memory off` 也会改状态;由 handler 在参数和附件校验通过后 append 专用记录更准确。
- **用 `session.append` 写自定义事件。** `session.append` 不写 `ignorable` 标记,而持久化读取只接受已知事件类型或带该标记的记录;续聊会拒绝整条日志。改用 `appendPluginRecord`,记录带 `ignorable: true`,旧 reader 会保留并跳过。
- **只保留斜杠命令,不做 pill。** 少一个 client 面;但用户要在 composer 上看到并切换,命令不够直观,故在同一个包里加了手写 client pill。
- **拆独立 `dsh-claude-memory-ui` 包。** 核心包可保持无 client、UI 可独立发版;但要多装一个包、维护 client 包清单,而这里 UI 很小,放同一包更省。
- **用 tsdown 构建 client bundle。** 能拿 CSS modules、HMR 和 source map;但本仓库是纯 ESM 无构建,手写闭包只依赖 loader 契约,当前 UI 足够小,先不引入工具链。

## Consequences

- 收益:同一 dsh 进程里可以按会话、按来源决定读哪份记忆,不需要改 profile;加来源不改状态格式和 client。全部关掉且没有 own store 时连磁盘 stat 都不做;有 own store 时每会话仍注入一次静态的目录与规则段。
- 代价:server 新增两个宿主接口——可选的 `commands` 注册和 `appendPluginRecord('plugin:claude-memory/mode')`;后者让 `@deepseek-ai/dsh-session`(>= 0.2.1-alpha.2)成为 peer 依赖;更旧的宿主只记一条警告、不注册 `/memory`,注入继续。client 半用 `slots`/`remote`/`remote.commands`/`sessions`/`locale`,并让 `dsh.client` 进入 web 构建。命令名 `memory` 若与别的插件冲突,注册失败只记警告,注入继续,但该会话无法切换。
- 关闭前已经注入的索引仍在模型上下文里;要真正无记忆,应在会话第一轮前关闭,或使用不装插件的 profile/preset。
- shipped headless/ACP 没有命令 adapter,或宿主缺少 `appendPluginRecord` 时只能停在配置默认值;这类宿主要读 Claude Code 索引得在 profile 里设 `readByDefault.claude: true`。后者加载时记警告。
- 宿主对 plugin record 的格式迁移是 best-effort:普通续聊、fork、压缩会携带该记录,迁移若丢失它,开关回到配置默认值。
- peer 范围 `>=0.2.1-alpha.2` 按 semver 只匹配同 patch 的预发布版;后续 patch 的 alpha/beta 可能被 pnpm 判为不满足,正式版不受影响。
- client 改动没有构建/HMR,改完要重启 profile:web;`dsh.client` 指向的 `src/client.js` 缺失或语法错误会让 web 客户端加载失败。
- 每点一行都走一次 `/memory <source> on|off` 命令,会话日志会留下 `command/run`、`command/done`,界面可能显示一条命令记录;这是宿主命令面的既有行为。
- `conversation.input.right` 不传 `locked`;removed/inert 会话上的菜单仍可点,失败文本会显示在按钮旁。subagent 会话已由 `sessions.subagentAddress` 隐藏。菜单是手写的绝对定位面板,没有点击外部自动收起,再点按钮才收。
- 若 `/memory` 已被别的插件占用或按 agent 遮蔽,client 的命令归属检查会失败,不会执行别人的同名命令;按钮仍可见,可能显示错误。
- 按钮读 `wire` view;旧 server 不提供该 view 时不出现,斜杠命令仍可用。
