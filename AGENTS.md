# AGENTS.md

dsh-claude-memory 是一个 DeepSeek Harness(dsh)插件:每个会话第一步确定性注入项目的记忆索引,Claude Code 的只读,dsh 自己的由模型写。用法、配置、安装见 [README.md](README.md);这里只放开工规则和代码里看不出的决策。

## 设计决策

理由、被否方案和后果都在 `.agents/notes/implemented/`,改相关代码先读再改,事实变了就地更新那篇:

- 架构:[宿主注入,不靠模型自觉](.agents/notes/implemented/architecture/2026-10-12-host-injection-not-model-discipline.md) · [注入消息是 `user/message` snapshot,来源 `plugin:claude-memory`](.agents/notes/implemented/architecture/2026-10-12-snapshot-user-message-event.md) · [去重状态放会话投影,不扫历史](.agents/notes/implemented/architecture/2026-10-12-dedup-state-in-session-projection.md)
- 行为:[只注入索引、按需读、对记忆只读](.agents/notes/implemented/feature/2026-10-12-index-only-read-only.md) · [snapshot 替代语义、摘要去重与撤回](.agents/notes/implemented/feature/2026-10-12-snapshot-replacement-and-withdrawal.md) · [记忆目录定位顺序,无 cwd 不注入](.agents/notes/implemented/feature/2026-10-12-memory-directory-location.md) · [子代理默认不注入](.agents/notes/implemented/feature/2026-10-12-subagents-not-injected-by-default.md)
- 开关:[会话级 memory 开关](.agents/notes/implemented/feature/2026-10-26-session-memory-toggle.md) · [dsh 自己的记忆目录](.agents/notes/implemented/feature/2026-10-26-own-memory-store.md)
- 修复:[插入位置找不到锚点就放尾部](.agents/notes/implemented/bug-fix/2026-10-12-insert-at-tail-without-anchor.md)

## 代码约定

- 纯 ESM JS,无构建。`src/locate.js` 只依赖 `node:fs`(定位、有界读取、截断、渲染),全部异步,不 import 宿主包;`src/index.js` 只做挂载与注入。新逻辑先问能不能放进 `locate.js`。
- 宿主接口只用六个:`agent/pre-step`(必须 `await next()`)、`session.header.cwd/origin`、`ctx.sessionProjections.register/stateOf`、`createUserMessage`、可选的 `ctx.commands.register`、`appendPluginRecord('plugin:claude-memory/mode')`。不碰 `session.eventAt`/`surface.nodes` 这类同步读历史的接口;多用一个就在这里记一笔。
- 配置走 `@deepseek-ai/schemastery` 的 `Config`,默认值取 Claude Code 的值(例外:`enabledByDefault`、`ownMemory*`);不加 `DEFAULT_*` 常量。
- 有 client:`dsh.client` 指向手写 `src/client.js`(无构建,`__ModuleLoader__.load` 闭包);文件缺失会让 `dsh web` 起不来,改完重启 profile:web。
- 测试用 `node --test`,不启动 dsh:`test/locate.test.js` 用临时目录,`test/plugin.test.js` 用假 ctx/agent 驱动监听器,模式记录走真实 Session。peer 依赖靠仓库根的 `node_modules -> ~/.dsh/profiles/node_modules` 软链。

## 安装与验证

- profile 用 `link:` 装,并把包名加进 `dsh.profile.bundles`,缺一静默不加载。在 profile 目录跑 `pnpm add link:…`;经 deepseek-harness 的 `pnpm dsh plugin` 转发会继承仓库 pnpm store 而失败。
- 改源码不用重装,重启 profile:web 是 launchd 的 `local.dsh.web`,`launchctl kickstart -k gui/$(id -u)/local.dsh.web`;headless 从 deepseek-harness 仓库 `pnpm dsh --profile headless "…"` 即时生效。
- 真正的验证是看会话日志:`zstd -dc ~/.dsh/sessions/<cwd-slug>/<session>/session.v4.jsonl.zstd` 里应有一条 `"kind":"plugin:claude-memory"` 的 `user/message`,紧跟用户消息之后。问一个只有记忆才知道的问题,模型应零工具调用答出。
- `pnpm dsh web --dump-config | grep claude-memory` 能确认行已挂进 web 的 cordis 树。

## 不做的事

- 插件进程不写文件、不摘要、不检索;UI 只做模型选择旁的记忆开关。
- 不碰 dsh 主仓库;dsh 的接口变了就改这里,不改那边。

## 开工规矩(skills)

- 非平凡改动先按 [write-notes-like-deepseek](.agents/skills/write-notes-like-deepseek/SKILL.md) 立或更新 Agent Note;已有归属的决定就地改事实,不另起新篇。
- 每个 clone 跑一次 `git config core.hooksPath .githooks`,提交和推送自动过门禁([为什么不用 lefthook](.agents/notes/implemented/process/2026-10-12-git-hooks-and-ci-without-lefthook.md))。
- 推送前按 [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md) 只跑覆盖本次改动的检查;`node .agents/skills/dsh-gate-every-rule/scripts/run-gates.ts` 跑全部门禁。
- 改了 `cordis.patch.yml` 的键、`Config` 字段或注入文本格式,同批按 [dsh-create-upgrade-guide](.agents/skills/dsh-create-upgrade-guide/SKILL.md) 写升级指南。
- 错误处理按 [dsh-error-handling](.agents/skills/dsh-error-handling/SKILL.md);注入文本按 [dsh-agent-experience](.agents/skills/dsh-agent-experience/SKILL.md);注释与文档按 [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md),会话痕迹用 [dsh-trim-cot-leakage](.agents/skills/dsh-trim-cot-leakage/SKILL.md) 清。
- 本文件字数上限在 `.agents/doc-budgets.json`,只降不升;加规则先把细节下沉到链接目标([dsh-layer-instructions](.agents/skills/dsh-layer-instructions/SKILL.md))。
