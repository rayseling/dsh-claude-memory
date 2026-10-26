---
kind: upgrade-guide
description: "注入文本改为两段式并带写入规则,模型默认开始往 ~/.dsh/memory/<slug>/ 写记忆;新配置项 ownMemory / ownMemoryHome"
---

# dsh 自己的记忆目录:注入文本改版,模型开始写 `~/.dsh/memory`

## 变更

0.4.0 的注入消息只有一段:Claude Code 的 `MEMORY.md` 索引,并要求模型不创建、修改、删除任何记忆文件。0.5.0 起消息分两段:Claude Code 索引段(仍只读)在前,dsh 自己的段在后,后者给出目录 `<ownMemoryHome>/<slug>/`(默认 `~/.dsh/memory/<slug>/`)、该目录的 `MEMORY.md` 内容,以及写记忆的规则(记什么、文件格式、写完给索引加一行)。只要配了 `ownMemory` 且会话有工作目录,即使项目没有任何记忆、即使所有来源的读取都关着,每个会话至少会多一条几百 token 的消息:写记忆不是会话级开关,见[按来源的读取开关](../read-switch-per-source/guide.md)。撤回消息只在 `ownMemory: false` 且 Claude Code 索引消失时出现。

模型从此会在 `~/.dsh/memory/` 下创建文件;插件进程本身仍不写任何文件。记忆文件格式与 Claude Code 相同(frontmatter `name` / `description` / `metadata.type`),没有 `modified` / `originSessionId`。

新配置项:`ownMemory`(默认 `true`)、`ownMemoryHome`(默认 `~/.dsh/memory`)。事件类型、`source.kind` 都没变;`source.path` 在没有 Claude Code 索引时指向自己的 `MEMORY.md`。

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

2. 重启 profile(web 是 `launchctl kickstart -k gui/$(id -u)/local.dsh.web`),在开着记忆的会话里发一句话。会话日志 `session.v4.jsonl.zstd` 里 `"kind":"plugin:claude-memory"` 的消息应以 `Persistent memory for this project` 开头;`ownMemory: true` 时还应包含 `Save a memory in`,`false` 时不包含。

3. 让模型记一件事,然后看 `~/.dsh/memory/<slug>/MEMORY.md` 多了一行、同目录多了一个 `.md`;下一轮注入消息里应出现这一行。
