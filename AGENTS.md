# AGENTS.md

dsh-claude-memory 是一个 DeepSeek Harness(dsh)插件:在每个会话第一步把项目对应的 Claude Code 记忆索引 `MEMORY.md` 确定性注入上下文。用法、配置、安装步骤见 [README.md](README.md);这里只放每次开工都要遵守的规则和不能从代码里看出来的决策。

## 设计决策

- **宿主注入,不靠模型自觉。** 先试过在 `~/.dsh/AGENTS.md` 里写指令让模型自己跑命令读索引;dsh 把工作区指令包装成 "may be relevant / use when applicable",第一次真实会话模型就直接跳过了。Claude Code 自己也是宿主把索引塞进上下文,所以这里必须是插件。
- **只注入索引,条目按需读。** 与 Claude Code 完全一致:索引上限 200 行 / 25 KB,先到为准;条目文件不预加载,注入文本告诉模型只在相关时 `cat`。不要加检索层(memsearch 那类)——Claude Code 本身没有检索,索引里的一行钩子就是检索。
- **只读。** 记忆由 Claude Code 维护;本插件永远不创建、不修改、不删除 `~/.claude` 下任何文件,注入文本也要求模型不这么做。
- **消息是 `user/message` 事件,来源 `plugin:claude-memory`,form `snapshot`。** 这样它随会话日志重放、压缩、续聊,模型可见内容都可从日志重建(dsh 的"model-visible ⟺ logged"规则)。`kind: 'plugin'` 是 V4 格式拒绝的旧写法,不要用。
- **摘要去重,snapshot 覆盖。** 来源里带 sha256;最近一条可见的本插件 snapshot 摘要相同就不注入,不同就以新 snapshot 进入。按"最新一条"判断而不是"任意一条",因为 snapshot 语义是后者覆盖前者。压缩后旧消息离开 surface,会自然重新注入。
- **定位顺序:git 根 → linked worktree 的主仓库 → 工作目录。** Claude Code 的 slug 取自仓库根(路径非字母数字字符全换成 `-`),文档说记忆跨 worktree 共用,但旧版给 worktree 路径单独建过目录,所以两个都试。全部用 fs 判断,不 spawn git。
- **子代理默认不注入。** Claude Code 不给子代理记忆(fork 除外);`includeSubagents` 留作开关。

## 代码约定

- 纯 ESM JS,无构建。`src/locate.js` 只有纯函数(定位、截断、渲染),不 import 宿主包;`src/index.js` 只做挂载与注入。新逻辑先问能不能放进 `locate.js`。
- 宿主接口只用四个:`agent/pre-step` waterfall(必须 `await next()` 再决定)、`session.header.cwd/origin`、`session.surface.nodes` + `session.eventAt`、`@deepseek-ai/dsh-llm` 的 `createUserMessage`。多用一个就要在这里记一笔。
- 配置走 `@deepseek-ai/schemastery` 的 `Config`,默认值就是 Claude Code 的值;不加 `DEFAULT_*` 常量。
- 没有 client,`package.json` 不声明 `dsh.client`(声明了找不到文件会让 `dsh web` 起不来)。
- 测试用 `node --test`,不启动 dsh:`test/locate.test.js` 用临时目录,`test/plugin.test.js` 用假的 ctx/agent/session 直接驱动监听器。peer 依赖靠仓库根的 `node_modules -> ~/.dsh/profiles/node_modules` 软链解析。

## 安装与验证

- profile 里用 `link:` 装(源码即所得),并把包名加进 `dsh.profile.bundles`,两处缺一都会静默不加载。直接在 profile 目录跑 `pnpm add link:…`;通过 deepseek-harness 仓库的 `pnpm dsh plugin` 转发会继承仓库的 pnpm store 环境而失败。
- 改源码不用重装,重启 profile:web 是 launchd 的 `local.dsh.web`,`launchctl kickstart -k gui/$(id -u)/local.dsh.web`;headless 从 deepseek-harness 仓库 `pnpm dsh --profile headless "…"` 即时生效。
- 真正的验证是看会话日志:`zstd -dc ~/.dsh/sessions/<cwd-slug>/<session>/session.v4.jsonl.zstd` 里应有一条 `"kind":"plugin:claude-memory"` 的 `user/message`,紧跟用户消息之后。问一个只有记忆才知道的问题,模型应零工具调用答出。
- `pnpm dsh web --dump-config | grep claude-memory` 能确认行已挂进 web 的 cordis 树。

## 不做的事

- 不写记忆、不做摘要、不做检索、不加 UI。
- 不碰 dsh 主仓库;dsh 的接口变了就改这里,不改那边。
