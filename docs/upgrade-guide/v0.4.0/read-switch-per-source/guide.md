---
kind: upgrade-guide
description: "enabledByDefault 被按来源的 readByDefault 取代,/memory 语法带来源,pill 变成按来源的菜单,mode 投影 stateVersion 2 → 3"
---

# 按来源的读取开关:`readByDefault` 取代 `enabledByDefault`,`/memory` 带来源

## 变更

0.4.0 的 `/memory on|off|status` 是一个总开关,配置项 `enabledByDefault`(默认 `false`)决定没切换过的会话;composer 上是一个 "Claude Code 记忆" pill。0.5.0 起记忆有两个来源,`claude`(Claude Code 索引)和 `dsh`(dsh 自己的目录),读取按来源分别开关:`/memory <source> on|off`,裸 `/memory on|off` 作用于全部来源,`/memory status` 回显每个来源。没切换过的来源取配置项 `readByDefault`,默认 `{ claude: false, dsh: true }`;`enabledByDefault` 键被忽略。`ownMemory: false` 的 profile 没有 `dsh` 来源:状态回显和菜单只列 `claude`,`/memory dsh on|off` 报错。composer 上变成一个"记忆"按钮,点开后每个来源一行、各自开关;按钮文字列出正在读的来源。写记忆不受这些开关影响;关它的途径是 `ownMemory: false`,此外 read-only 会话和未配 `includeSubagents` 的子代理会被工具拒绝。

命令回显从 `Claude Code memory is on` 改为 `Memory read: claude off, dsh on` 这一形态。投影 `claudeMemoryMode` 的 `stateVersion` 从 2 升到 3,状态从 `{ enabled }` 改为 `{ read: { [source]: boolean } }`;旧 checkpoint 被丢弃并从日志重算。0.4.0 写下的 `plugin:claude-memory/mode` 记录没有 `source`,按 `claude` 来源折叠,所以运行过 `/memory on|off` 的旧会话保留它对 Claude Code 索引的选择。wire view 从 `{ enabled }` 改为 `{ sources: [{ id, enabled }] }`。

受影响的是每个装了本插件的 profile,以及任何读 `claudeMemoryMode` view 或匹配命令回显的脚本。

## 迁移

1. profile 的 `cordis.patch.yml` 里 id `claude-memory` 下若有 `enabledByDefault: true`,改为:

   ```yaml
   config:
     readByDefault:
       claude: true
   ```

   `enabledByDefault: false` 直接删掉即可;要连 dsh 自己的索引也默认不读,加 `dsh: false`。

2. 重启 profile(web 是 `launchctl kickstart -k gui/$(id -u)/local.dsh.web`),在任一会话运行 `/memory status`,应回显 `Memory read: claude <on|off>, dsh <on|off>`,与配置一致。composer 模型选择旁应出现"记忆"按钮,点开有 Claude Code 和 DSH 两行。
