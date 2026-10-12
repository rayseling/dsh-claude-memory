# AGENTS.md

dsh-claude-memory 是一个 DeepSeek Harness(dsh)插件:在每个会话第一步把项目对应的 Claude Code 记忆索引 `MEMORY.md` 确定性注入上下文。用法、配置、安装步骤见 [README.md](README.md);这里只放每次开工都要遵守的规则和不能从代码里看出来的决策。

## 设计决策

- **宿主注入,不靠模型自觉。** 先试过在 `~/.dsh/AGENTS.md` 里写指令让模型自己跑命令读索引;dsh 把工作区指令包装成 "may be relevant / use when applicable",第一次真实会话模型就直接跳过了。Claude Code 自己也是宿主把索引塞进上下文,所以这里必须是插件。
- **只注入索引,条目按需读。** 与 Claude Code 完全一致:索引上限 200 行 / 25,000 UTF-16 code unit(文档写 25KB,claude-code#97453 实测 code unit,未被维护者确认),先到为准;截断永远落在完整字符边界,首行超限时给前缀;条目文件不预加载,注入文本告诉模型只在相关时 `cat`。不要加检索层(memsearch 那类)——Claude Code 本身没有检索,索引里的一行钩子就是检索。
- **只读。** 记忆由 Claude Code 维护;本插件永远不创建、不修改、不删除 `~/.claude` 下任何文件,注入文本也要求模型不这么做。
- **消息是 `user/message` 事件,来源 `plugin:claude-memory`,form `snapshot`。** 这样它随会话日志重放、压缩、续聊,模型可见内容都可从日志重建(dsh 的"model-visible ⟺ logged"规则)。`kind: 'plugin'` 是 V4 格式拒绝的旧写法,不要用。
- **去重状态放在会话投影里,不扫历史。** `Session.eventAt/snapshotEvents/ownEvents` 已被 dsh 弃用并禁止新增调用(agents note 2026-09-09),所以用 `ctx.sessionProjections.register` 注册 `claudeMemory` 投影:纯折叠,记录本插件最新一条在 surface 上的 snapshot 的 seq/digest/path,`user/message` 命中时更新,`surfaceOp.op === 'replace'` 且事件的 `sourceEventSeqs` 包含该 seq 时清空(宿主要求替换事件列出每个被遮蔽节点;surface 顺序不保证 seq 递增,所以不能按 `startSeq..endSeq` 区间判断,区间只在事件没带 source 列表时兜底;压缩后会重新注入)。pre-step 只读 `stateOf`。`stateSchema` 是手写的 `{ parse }`,不引入 zod。改了状态字段或折叠语义必须 bump `stateVersion`。
- **新 snapshot 不会让旧的从模型上下文消失。** `form: 'snapshot'` 只是给消费者的语义,宿主不会删旧消息,所以注入文本里必须写明"这是完整的当前索引,替代此前展示过的",否则被删掉的条目还会被模型当成存在。
- **摘要相同不注入,不同就新 snapshot 覆盖;记忆消失要撤回,读不到不算消失。** 展示过的索引文件不见了(stat 得 ENOENT/ENOTDIR)或变空,进入一条撤回 snapshot(同样带 digest,所以只进一次),否则模型会一直把旧索引当现状。读失败、stat 得其它错误(EACCES/EIO)说明不了内容,`currentIndex` 用判别式 `kind: 'text' | 'blank' | 'error'` 区分,error 不缓存、不撤回、每会话只警告一次;冷缓存加一次抖动曾经造出过假撤回(0.2.0)。
- **没有记录的工作目录就不注入。** `header.cwd` 可能缺失;退回 `process.cwd()` 会把 dsh 进程所在项目(通常是 harness 仓库或 profile)的记忆塞给别的项目,模型无从分辨。
- **插入位置找不到锚点就放尾部。** 上游监听器可能把 claimed 消息换成副本,`findLastIndex` 得 -1 时若按 0 插入会排到用户提问前面。
- **定位顺序:git 根 → linked worktree 的主仓库 → 工作目录,字面路径和真实路径各来一遍。** Claude Code 的 slug 取自仓库根(路径非字母数字字符全换成 `-`),文档说记忆跨 worktree 共用,但旧版给 worktree 路径单独建过目录,所以两个都试。主仓库按 git 自己的 `<gitdir>/commondir` 推:common dir 是某个仓库的 `.git` 目录时取其父目录,否则(`--separate-git-dir`)推不出、放弃。不猜 `/.git/worktrees/` 这种目录名。全部用 fs 判断,不 spawn git;只有 ENOENT/ENOTDIR 算"不存在",其它错误一律抛给 pre-step 去警告,绝不吞成"没有"。
- **子代理默认不注入。** Claude Code 不给子代理记忆(fork 除外);`includeSubagents` 留作开关。

## 代码约定

- 纯 ESM JS,无构建。`src/locate.js` 只依赖 `node:fs`(定位、有界读取、截断、渲染),全部异步,不 import 宿主包;`src/index.js` 只做挂载与注入。新逻辑先问能不能放进 `locate.js`。
- 宿主接口只用四个:`agent/pre-step` waterfall(必须 `await next()` 再决定)、`session.header.cwd/origin`、`ctx.sessionProjections.register/stateOf`、`@deepseek-ai/dsh-llm` 的 `createUserMessage`。不要碰 `session.eventAt`/`surface.nodes` 这类同步读历史的接口。多用一个就要在这里记一笔。
- 配置走 `@deepseek-ai/schemastery` 的 `Config`,默认值就是 Claude Code 的值;不加 `DEFAULT_*` 常量。
- 没有 client,`package.json` 不声明 `dsh.client`(声明了找不到文件会让 `dsh web` 起不来)。
- 测试用 `node --test`,不启动 dsh:`test/locate.test.js` 用临时目录,`test/plugin.test.js` 用假的 ctx/agent/session 直接驱动监听器。peer 依赖靠仓库根的 `node_modules -> ~/.dsh/profiles/node_modules` 软链解析。

## 安装与验证

- profile 里用 `link:` 装(源码即所得),并把包名加进 `dsh.profile.bundles`,两处缺一都会静默不加载。直接在 profile 目录跑 `pnpm add link:…`;通过 deepseek-harness 仓库的 `pnpm dsh plugin` 转发会继承仓库的 pnpm store 环境而失败。
- 改源码不用重装,重启 profile:web 是 launchd 的 `local.dsh.web`,`launchctl kickstart -k gui/$(id -u)/local.dsh.web`;headless 从 deepseek-harness 仓库 `pnpm dsh --profile headless "…"` 即时生效。
- 真正的验证是看会话日志:`zstd -dc ~/.dsh/sessions/<cwd-slug>/<session>/session.v4.jsonl.zstd` 里应有一条 `"kind":"plugin:claude-memory"` 的 `user/message`,紧跟用户消息之后。问一个只有记忆才知道的问题,模型应零工具调用答出。
- `pnpm dsh web --dump-config | grep claude-memory` 能确认行已挂进 web 的 cordis 树。

## 命名

- 来源 `kind` 是 `plugin:claude-memory`:V4 迁移给第三方生产者的约定就是 `plugin:<name>`(first-party 才用裸名),已落盘的会话也用它,不要改。它和事件类型命名空间 `plugin:<record>` 同形但是不同字段。

## 不做的事

- 不写记忆、不做摘要、不做检索、不加 UI。
- 不碰 dsh 主仓库;dsh 的接口变了就改这里,不改那边。

## 开工规矩(skills)

- 非平凡改动先按 [write-notes-like-deepseek](.agents/skills/write-notes-like-deepseek/SKILL.md) 立或更新 Agent Note;上面「设计决策」一节是待迁入 `.agents/notes/implemented/` 的存量。
- 推送前按 [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md) 只跑覆盖本次改动的检查;`node .agents/skills/dsh-gate-every-rule/scripts/run-gates.ts` 跑全部门禁。
- 改了 `cordis.patch.yml` 的键、`Config` 字段或注入文本格式,同批按 [dsh-create-upgrade-guide](.agents/skills/dsh-create-upgrade-guide/SKILL.md) 写升级指南。
- 错误处理按 [dsh-error-handling](.agents/skills/dsh-error-handling/SKILL.md);注释与文档按 [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md),会话痕迹用 [dsh-trim-cot-leakage](.agents/skills/dsh-trim-cot-leakage/SKILL.md) 清。
- 本文件字数上限在 `.agents/doc-budgets.json`,只降不升;加规则先把细节下沉到链接目标([dsh-layer-instructions](.agents/skills/dsh-layer-instructions/SKILL.md))。
