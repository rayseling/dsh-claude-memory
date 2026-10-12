# dsh-claude-memory

让 DeepSeek Harness 在任何工作目录下都拿到 Claude Code 为该项目维护的持久记忆,加载方式与 Claude Code 自己一致:会话第一步注入 `MEMORY.md` 索引,条目文件由模型按需读取。

Gives a DeepSeek Harness session the Claude Code auto-memory of the project it works in, loaded the way Claude Code loads it: the `MEMORY.md` index at the first step, topic files on demand.

## 它做什么

- 每轮第一步,按 Claude Code 的规则定位项目记忆:`<claudeHome>/projects/<slug>/memory/MEMORY.md`,`<slug>` 是项目绝对路径把所有非字母数字字符换成 `-`。项目优先取 git 仓库根;在 linked worktree 里先试 worktree 自身路径,再试主仓库;不在 git 里就用工作目录本身。
- 索引按 Claude Code 的上限截断:前 200 行或前 25,000 个 UTF-16 code unit(文档写 "25KB",anthropics/claude-code#97453 实测为 code unit,维护者未确认),先到为准。截点回退到最后一个行尾;首行就超限时给该行不劈代理对的前缀。磁盘上最多只读 `3 × maxChars + 1` 字节。
- 以 `user` 角色、来源 `plugin:claude-memory`(form `snapshot`)的消息进入会话,位置紧跟本轮用户消息之后。它是普通的 `user/message` 会话事件,随日志重放、压缩、续聊;模型可见的内容都能从日志重建。
- 一个会话投影(`claudeMemory`)记录本插件最新一条仍在 surface 上的 snapshot 及其内容摘要,由已提交事件维护、续聊时恢复、被压缩替换时清空。摘要相同就不注入;索引变了就以新 snapshot 进入;索引在展示过之后消失或变空,进入一条撤回 snapshot。文件的 size/mtime 没变就复用上次渲染,不重新读盘。
- 条目文件不预加载。注入文本告诉模型:只在任务相关时用 shell `cat` 读对应文件,不要全读;这些文件由 Claude Code 维护,只读不改。
- 子代理会话默认不注入(Claude Code 也不给子代理记忆)。会话 header 没有记录工作目录时也不注入,绝不退回到 dsh 进程自己的目录。

## 安装

在 profile 目录里以 link 方式安装,然后把包名加进 `dsh.profile.bundles`:

```sh
cd ~/.dsh/profiles/web
pnpm add link:/path/to/dsh-claude-memory
# package.json → dsh.profile.bundles 追加 "dsh-claude-memory"
```

重启该 profile。验证:新会话的日志里出现 `"kind":"plugin:claude-memory"` 的 `user/message`。

`dsh plugin --profile web add link:…` 等价,但若通过仓库里的 `pnpm dsh` 转发,会继承仓库的 pnpm store 环境而失败;直接在 profile 目录跑 pnpm 即可。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id `claude-memory` 覆盖:

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `claudeHome` | `~/.claude` | Claude Code 配置目录,含 `projects/` |
| `maxLines` | `200` | 注入的索引最多行数 |
| `maxChars` | `25000` | 注入的索引最多 UTF-16 code unit 数 |
| `includeSubagents` | `false` | 是否也给子代理会话注入 |

## 开发

```sh
ln -s ~/.dsh/profiles/node_modules node_modules   # 解析 peer 依赖
npm test                                           # node --test
```

`src/locate.js` 只依赖 `node:fs`(定位、有界读取、截断、渲染),`src/index.js` 做投影注册、挂载与注入;测试用假的 Cordis 上下文(含会按宿主语义折叠事件的假投影注册表)驱动监听器,不需要启动 dsh。
