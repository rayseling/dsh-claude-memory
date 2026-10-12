# dsh-claude-memory

让 DeepSeek Harness 在任何工作目录下都拿到 Claude Code 为该项目维护的持久记忆,加载方式与 Claude Code 自己一致:会话第一步注入 `MEMORY.md` 索引,条目文件由模型按需读取。

Gives a DeepSeek Harness session the Claude Code auto-memory of the project it works in, loaded the way Claude Code loads it: the `MEMORY.md` index at the first step, topic files on demand.

## 它做什么

- 每轮第一步,按 Claude Code 的规则定位项目记忆:`<claudeHome>/projects/<slug>/memory/MEMORY.md`,`<slug>` 是项目绝对路径把所有非字母数字字符换成 `-`。项目优先取 git 仓库根;在 linked worktree 里先试 worktree 自身路径,再试主仓库;不在 git 里就用工作目录本身。
- 索引按 Claude Code 的上限截断:前 200 行或前 25 KB,先到为准,截到整行。
- 以 `user` 角色、来源 `plugin:claude-memory`(form `snapshot`)的消息进入会话,位置紧跟本轮用户消息之后。它是普通的 `user/message` 会话事件,随日志重放、压缩、续聊;模型可见的内容都能从日志重建。
- 来源里带内容摘要:最近一条可见的记忆 snapshot 已是当前内容就不再注入;索引变了就以新 snapshot 进入,覆盖旧的。
- 条目文件不预加载。注入文本告诉模型:只在任务相关时用 shell `cat` 读对应文件,不要全读;这些文件由 Claude Code 维护,只读不改。
- 子代理会话默认不注入(Claude Code 也不给子代理记忆)。

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
| `maxBytes` | `25600` | 注入的索引最多字节数 |
| `includeSubagents` | `false` | 是否也给子代理会话注入 |

## 开发

```sh
ln -s ~/.dsh/profiles/node_modules node_modules   # 解析 peer 依赖
npm test                                           # node --test
```

`src/locate.js` 是纯函数(定位、截断、渲染),`src/index.js` 只做挂载与注入;测试用假的 Cordis 上下文和会话驱动监听器,不需要启动 dsh。
