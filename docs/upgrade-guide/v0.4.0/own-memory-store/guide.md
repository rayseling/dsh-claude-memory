---
kind: upgrade-guide
description: "注入文本改为两段式并带写入规则,模型默认开始往 ~/.dsh/memory/<slug>/ 写记忆;新配置项 ownMemory / ownMemoryHome"
---

# dsh 自己的记忆目录:注入文本改版,模型开始写 `~/.dsh/memory`

## 变更

0.4.0 的注入消息只有一段:Claude Code 的 `MEMORY.md` 索引,并要求模型不改记忆文件。0.5.0 起分两段:Claude Code 索引段(仍只读)在前,dsh 自己的段在后,给出目录 `<ownMemoryHome>/<slug>/`(默认 `~/.dsh/memory/<slug>/`)、其索引和写记忆的规则。配了 `ownMemory` 且会话有工作目录时,即使没有记忆、读取都关着,每个会话也多一条几百 token 的消息:写不是会话级开关,见[按来源的读取开关](../read-switch-per-source/guide.md)。撤回消息只在 `ownMemory: false` 且 Claude Code 索引消失时出现。

模型多了两个工具 `memory_save` 和 `memory_delete`,注册在 `ctx.tools` 上,在服务端直接写 `~/.dsh/memory/<slug>/`,不经过文件沙箱;`read-only` 会话、或子代理在 `includeSubagents` 关着时,工具拒绝写。`MEMORY.md` 只是条目文件投影的缓存,坏了不影响注入;工具条目的行被手工改过会换回 `title` / `hook`,非条目行不保留;没有这两个字段的手写条目保留已有行;文件名不合文法(如含空格)的 `.md` 只保留旧行并记警告。写后按 200 行 / 25000 字符度量:接近时提醒,超过时文件已写入但工具返回错误。宿主没有 `tools` 时记警告,段改说无法写入。`ownMemoryHome` 必须是绝对路径(`~/` 可用),否则记警告并关掉 own store。

新配置项 `ownMemory`(默认 `true`)、`ownMemoryHome`(默认 `~/.dsh/memory`);新 peer 依赖 `@deepseek-ai/dsh-tools`。事件类型、`source.kind` 不变;没有 Claude Code 索引时 `source.path` 指向自己的 `MEMORY.md`。

受影响的是每个装了本插件的 profile,以及按 "Contents of … (Claude Code's persistent memory index" 匹配注入消息的脚本。

## 迁移

1. 要保持 0.4.0 的只读行为,在 profile 的 `cordis.patch.yml` 里给 id `claude-memory` 加配置:

   ```yaml
   - insert:
       - id: claude-memory
         name: dsh-claude-memory
         config:
           ownMemory: false
   ```

   换目录设 `ownMemoryHome`。

2. 重启 profile(web 是 `launchctl kickstart -k gui/$(id -u)/local.dsh.web`),在任一会话发一句话。会话日志里 `"kind":"plugin:claude-memory"` 的消息应以 `Persistent memory for this project` 开头;`ownMemory: true` 时还应包含 `memory_save`。

3. 让模型记一件事,它应调用 `memory_save` 而不是文件工具,随后 `~/.dsh/memory/<slug>/` 多一个 `.md`;下一轮注入消息里应出现这一行。
