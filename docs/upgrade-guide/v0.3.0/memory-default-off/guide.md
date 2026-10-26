---
kind: upgrade-guide
description: "记忆开关默认从开改为关,新配置项 enabledByDefault 决定没切换过的会话的开关位置"
---

# 记忆开关默认关:`enabledByDefault` 取代隐含的默认开

## 变更

0.3.0 里没有运行过 `/memory off` 的会话一律加载 Claude Code 记忆索引。0.4.0 起没有运行过 `/memory on|off` 的会话取配置项 `enabledByDefault`,默认 `false`:新会话和所有没切换过的旧会话都不再注入索引,直到运行 `/memory on` 或点 composer 上的 Claude Code 记忆 pill。运行过 `/memory on|off` 的会话不受影响,它们的选择记录在会话日志里。

受影响的是每个装了本插件的 profile。没有命令面的宿主(shipped headless、ACP)没法在会话里打开开关,升级后这些宿主只有配置了 `enabledByDefault: true` 才会注入。

投影 `claudeMemoryMode` 的 `stateVersion` 从 1 升到 2,状态里的 `enabled` 新增 `null`;旧 checkpoint 会被丢弃并从日志重算,不需要手动处理。

## 迁移

1. 要保持 0.3.0 的"始终加载",在 profile 的 `cordis.patch.yml` 里给 id `claude-memory` 加配置:

   ```yaml
   - insert:
       - id: claude-memory
         name: dsh-claude-memory
         config:
           enabledByDefault: true
   ```

   接受默认关的 profile 不用改。

2. 重启 profile(web 是 `launchctl kickstart -k gui/$(id -u)/local.dsh.web`),在任一会话运行 `/memory status`:配置了 `true` 应回显 `Claude Code memory is on`,否则 `Claude Code memory is off`。
