---
kind: upgrade-guide
description: "注入文本改为两段式并带写入规则,模型默认开始往 ~/.dsh/memory/<slug>/ 写记忆;新配置项 ownMemory / ownMemoryHome"
---

# dsh 自己的记忆目录:注入文本改版,模型开始写 `~/.dsh/memory`

## 变更

0.4.0 的注入消息只有一段:Claude Code 的 `MEMORY.md` 索引,并要求模型不改任何记忆文件。0.5.0 起消息分两段:Claude Code 索引段(仍只读)在前,dsh 自己的段在后,给出目录 `<ownMemoryHome>/<slug>/`(默认 `~/.dsh/memory/<slug>/`)、其 `MEMORY.md` 内容和写记忆的规则。只要配了 `ownMemory` 且会话有工作目录,即使项目没有记忆、所有来源的读取都关着,每个会话也至少多一条几百 token 的消息:写不是会话级开关,见[按来源的读取开关](../read-switch-per-source/guide.md)。撤回消息只在 `ownMemory: false` 且 Claude Code 索引消失时出现。

模型多了两个工具 `memory_save` 和 `memory_delete`,由本插件注册在 `ctx.tools` 上,在服务端直接写 `~/.dsh/memory/<slug>/`,不经过文件沙箱(默认 `workspace-write` 不放行该目录),索引行由工具维护;写后按 200 行 / 25000 字符度量索引,接近时提醒精简,超过时文件已写入但工具返回错误。frontmatter 与 Claude Code 落盘的一致:`name` / `description` / `metadata.{node_type, type, originSessionId, modified}`。宿主没有 `tools` 服务时只记警告、注入照常,但文本仍提到工具,这类 profile 应设 `ownMemory: false`。`ownMemoryHome` 必须是绝对路径(`~/` 可用)。

新配置项 `ownMemory`(默认 `true`)、`ownMemoryHome`(默认 `~/.dsh/memory`);新 peer 依赖 `@deepseek-ai/dsh-tools`。事件类型、`source.kind` 不变;没有 Claude Code 索引时 `source.path` 指向自己的 `MEMORY.md`。

受影响的是每个装了本插件的 profile,以及任何按 "Contents of … (Claude Code's persistent memory index" 这一句匹配注入消息的脚本。

## 迁移

1. 要保持 0.4.0 的只读行为,在 profile 的 `cordis.patch.yml` 里给 id `claude-memory` 加配置:

   ```yaml
   - insert:
       - id: claude-memory
         name: dsh-claude-memory
         config:
           ownMemory: false
   ```

   接受默认值的 profile 不用改;要换目录就设 `ownMemoryHome`。

2. 重启 profile(web 是 `launchctl kickstart -k gui/$(id -u)/local.dsh.web`),在任一会话发一句话。会话日志 `session.v4.jsonl.zstd` 里 `"kind":"plugin:claude-memory"` 的消息,`<system-reminder>` 后第一行应以 `Persistent memory for this project` 开头;`ownMemory: true` 时还应包含 `memory_save`,`false` 时不包含。`pnpm dsh web --dump-config` 里应能看到 `memory_save` 工具。

3. 让模型记一件事,它应调用 `memory_save` 而不是文件工具,随后 `~/.dsh/memory/<slug>/MEMORY.md` 多一行、同目录多一个 `.md`;下一轮注入消息里应出现这一行。
