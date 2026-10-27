# dsh-claude-memory

让 DeepSeek Harness 在任何工作目录下都拿到该项目的持久记忆:Claude Code 维护的 `MEMORY.md` 索引只读注入,dsh 自己的记忆目录由模型按同一格式写;加载方式与 Claude Code 一致,会话第一步注入索引,条目文件由模型按需读取。

Gives a DeepSeek Harness session its project's persistent memory: the read-only Claude Code auto-memory index plus the harness's own store, which the model writes in the same format, loaded the way Claude Code loads memory: the index at the first step, topic files on demand.

## 它做什么

- 每轮第一步按 Claude Code 的规则定位 `<claudeHome>/projects/<slug>/memory/MEMORY.md`,`<slug>` 是项目绝对路径把非字母数字字符换成 `-`。项目取 git 根;linked worktree 先试自身,再按 `commondir` 找主仓库(`--separate-git-dir` 时推不出);不在 git 里用工作目录。字面和真实路径各找一遍。
- dsh 自己的记忆在 `<ownMemoryHome>/<slug>/`,`<slug>` 取规范根(主仓库 → git 根 → 工作目录,按真实路径),所有 worktree 共用;格式与 Claude Code 相同。模型用插件注册的 `memory_save` / `memory_delete` 工具写,服务端落盘(沙箱不放行 `~/.dsh`;read-only 会话和子代理被拒);注入的索引每轮从条目文件算出,`MEMORY.md` 只是缓存;没有记忆时也注入目录和规则。细节见 [dsh 自己的记忆目录](.agents/notes/implemented/feature/2026-10-26-own-memory-store.md)。
- 索引按 Claude Code 的上限截断:前 200 行或前 25,000 个 UTF-16 code unit(文档写 "25KB",anthropics/claude-code#97453 实测为 code unit),先到为准。截点回退到最后一个行尾;首行就超限时给不劈代理对的前缀。磁盘上最多只读 `3 × maxChars + 1` 字节。
- 两个索引合成一条 `user` 角色、来源 `plugin:claude-memory`(form `snapshot`)的消息进入会话,紧跟本轮用户消息之后。它是普通的 `user/message` 会话事件,随日志重放、压缩、续聊;模型可见的内容都能从日志重建。
- 会话投影 `claudeMemory` 记录最新一条仍在 surface 上的 snapshot 及其摘要,续聊时恢复,surface 替换在 `sourceEventSeqs` 里点名它时清空。摘要相同不注入;变了进新 snapshot,替代此前展示过的;两段都没得展示时进撤回 snapshot。Claude Code 索引 size/mtime 没变就复用上次读取;读或 stat 失败只警告一次、不注入、绝不当作撤回。细节见 [snapshot 替代与撤回](.agents/notes/implemented/feature/2026-10-12-snapshot-replacement-and-withdrawal.md)。
- 读哪些来源按会话选:`/memory claude|dsh on|off`(裸 `on|off` 全选,`status` 回显),或点模型选择旁的"记忆"菜单,每个来源一行各自开关;没切换过的取 `readByDefault`。关掉的来源不再加载,续聊保持,已注入的不删。写不受开关影响:`dsh` 读关着时仍给目录和规则,不带索引内容。
- 条目文件不预加载,模型按需 `cat`;Claude Code 目录只读不改。
- 子代理会话默认不注入(Claude Code 也如此);header 没有工作目录时不注入,不退回 dsh 进程的目录。

## 安装

在 profile 目录里以 link 方式安装,然后把包名加进 `dsh.profile.bundles`:

```sh
cd ~/.dsh/profiles/web
pnpm add link:/path/to/dsh-claude-memory
# package.json → dsh.profile.bundles 追加 "dsh-claude-memory"
```

重启 profile;新会话日志里应出现 `"kind":"plugin:claude-memory"` 的 `user/message`。

`dsh plugin --profile web add link:…` 等价,但经仓库里的 `pnpm dsh` 转发会因继承仓库的 pnpm store 失败。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id `claude-memory` 覆盖:

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `claudeHome` | `~/.claude` | Claude Code 配置目录,含 `projects/` |
| `maxLines` | `200` | 注入的索引最多行数 |
| `maxChars` | `25000` | 注入的索引最多 UTF-16 code unit 数 |
| `includeSubagents` | `false` | 是否也给子代理会话注入 |
| `readByDefault` | `{ claude: false, dsh: true }` | 没切换过的会话读哪些来源 |
| `ownMemory` | `true` | 是否给模型 dsh 自己的记忆目录与写入工具 |
| `ownMemoryHome` | `~/.dsh/memory` | 该目录的根,每个项目一个 `<slug>/` |

## 升级注意

- 0.2.0 起 `maxBytes` 改名 `maxChars`(字节改为 UTF-16 code unit);旧键会被静默忽略,请改名。
- 0.3.0 起 `/memory` 需要宿主提供 `appendPluginRecord`;旧版只警告并继续注入。
- 0.4.0 起开关默认关;保持始终加载要配 `enabledByDefault: true`([升级指南](docs/upgrade-guide/v0.3.0/memory-default-off/guide.md))。
- 0.5.0 起模型默认写 `~/.dsh/memory`([指南](docs/upgrade-guide/v0.4.0/own-memory-store/guide.md));`enabledByDefault` 改为 `readByDefault`,`/memory` 带来源([指南](docs/upgrade-guide/v0.4.0/read-switch-per-source/guide.md))。

## 开发

```sh
ln -s ~/.dsh/profiles/node_modules node_modules   # 解析 peer 依赖
npm test                                           # node --test
```

`src/locate.js` 只依赖 `node:fs`(定位、有界读取、截断、渲染),`src/index.js` 做投影注册、挂载与注入;测试用假的 Cordis 上下文(含按宿主语义折叠事件的假投影注册表)驱动监听器,不启动 dsh。
