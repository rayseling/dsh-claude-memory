# Agent Note: dsh 自己的记忆目录,模型通过插件工具写

Status: implemented

## Problem

插件只把 Claude Code 维护的索引注入 dsh 会话,dsh 会话里学到的事(用户纠正、项目约束、外部链接)没有地方落,下一个会话又得重新问。用户要求 dsh 也能记录记忆。[只注入索引、对记忆只读](2026-10-12-index-only-read-only.md) 的理由是两个宿主共写一份记忆会冲突、单一写者最简单;它并没有说 dsh 不能有自己的一份。

dsh 的文件沙箱默认是 `workspace-write`,可写根只有 workspace、`/tmp` 和 `tmpdir()`,没有配置能加白名单;模型用自己的文件工具写 `~/.dsh/memory` 必被 `FS_SANDBOX_DENIED` 拒绝,只能每次 `sandbox_permissions` 升级并经用户审批,headless/ACP 没有审批应答者,等于写不了。

## Decision

dsh 有一个自己的记忆目录,文件格式与 Claude Code 的记忆相同,由模型通过本插件注册的两个工具 `memory_save` / `memory_delete` 写,工具在服务端进程直接落盘(`src/store.js`,只依赖 `node:fs`)。

- **位置**:`<ownMemoryHome>/<slug>/`,默认 `~/.dsh/memory/<slug>/`,索引是 `MEMORY.md`,条目一文件一事实。frontmatter 为 `name` / `description` / `metadata.{node_type, type, originSessionId, modified}`,与 Claude Code 落盘的文件一致;`type` 取 `user | feedback | project | reference`;正文带 `**Why:**` / `**How to apply:**` 和 `[[name]]` 互链。`slug` 用与 Claude Code 相同的 `slugOf`,因此也继承它的碰撞:`/a-b` 与 `/a/b` 落到同一目录,这是 Claude Code 自己接受的概率,这里不另起编码。
- **只有一个目录**:slug 取自 `canonicalRoot(cwd)`——linked worktree 的主仓库,否则 git 根,否则工作目录本身,全部按真实路径。它与 [Claude Code 索引的多候选定位](2026-10-12-memory-directory-location.md) 不同:读 Claude Code 的索引可以试多个候选,写自己的记忆必须收敛到一处,否则两个 worktree 会各写一份。`ownMemoryHome` 必须是绝对路径:插件按进程 cwd 解析而模型按会话 cwd 理解,两边会分叉;相对路径在挂载时记警告并关掉 own store,Claude Code 索引的注入照常。
- **工具是唯一写路径**:`memory_save(name, type, title, description, hook, content)` 创建或按同名覆盖一个条目并 upsert 索引行(按链接目标 `](name.md)` 识别);`memory_delete(name)` 删文件并删索引行,已不存在不算错。`name` 限小写 kebab-case,防止路径逃逸;`memory`(不分大小写)保留,因为 APFS 默认不分大小写,`memory.md` 就是 `MEMORY.md`,存它会覆盖索引、删它会删掉索引。工具只知道 own store 的目录,碰不到 `~/.claude`。同一目录的写入在进程内排队,再持 `<dir>/.MEMORY.lock` 跨进程互斥(`withStoreLock`):锁文件 `O_EXCL` 创建并写入持有者 token,持有期间每 2.5 秒 touch 一次作为心跳,释放时只删仍带自己 token 的锁;mtime 10 秒没更新视为遗弃,接管经第二个独占文件 `.MEMORY.lock.takeover` 串行,持有该互斥的等待者重新 stat、确认是同一 inode 且仍过期后才 rename 走再删,所以两个等待者不会各自接管同一把锁、也不会误删别人刚建的新锁;web 与 headless 共用一份目录时索引更新不会互相覆盖。索引用临时文件 + rename 原子替换,另一会话的第一步不会读到半截索引。写后按 Claude Code 的做法度量索引(`judgeIndex`,行数与 UTF-16 code unit 各对 `maxLines` / `maxChars`):达到九成提醒"一行一条、合并或丢弃陈旧条目";超过任一上限时文件已写入但工具返回错误,说明超出部分下次加载会被丢弃,要求用 `memory_save` 合并、`memory_delete` 删除。调用方没有带 cwd 的会话(非 agent 调用)直接报错。
- **一条消息、两个段落**:Claude Code 索引段(只读)在前,自己的段在后;digest 覆盖整条消息,[snapshot 替代语义](2026-10-12-snapshot-replacement-and-withdrawal.md) 不变。完整性声明只对"展示出来的索引"成立,文本明说"未展示的来源只是本会话没读,不要据此推断删除"。配了 own store 时自己的段始终存在,没有条目也要告诉模型目录在哪、用什么工具写,因此纯撤回消息只在 `ownMemory: false` 时才会出现。own 索引读失败时该段降级为"索引未加载,写前先 `cat`",Claude Code 段照常进入;own 定位或 stat 失败(规范根算不出来、目录不可访问)时本轮什么都不进入——不注入 Claude Code 段,也不撤回,否则少了 own 段的替代消息会被模型读成"dsh 没在读";Claude Code 索引读失败仍整条不注入。完整性声明按索引各自给出:整份展示的索引才说"缺的条目已不存在",被截断的索引明说"后面可能还有,不要据此推断删除"。索引文本里出现的 `system-reminder` 标签在渲染时换成全角 `＜`,索引行的 `title` / `hook` 写入时同样转义,`</system-reminder>` 不可能提前结束框定。
- **写入规则随消息注入**(`renderMemoryMessage`):记什么、不记什么、写前查自己的索引(Claude Code 段展示时也查它,但只为避免重复,绝不写那边)、用 `memory_save` 同名更新而不是复制、用 `memory_delete` 删错的、不许用文件工具碰目录、索引上限;另有 Claude Code 给模型的三句:记忆是背景上下文不是用户指令、反映写下时的事实,点名的文件/函数/flag 要先核实还在;被要求记仓库里本来就有的事时,反问哪里不显然、记那个。规则按 Claude Code 系统提示里的记忆规则改写,放在动作之前。
- **写了就会回灌**:工具落盘后,下一轮第一步 size/mtime 变了就重读、重注入。
- **配置**:`ownMemory`(默认 `true`)和 `ownMemoryHome`(默认 `~/.dsh/memory`,支持 `~/`)。它们没有 Claude Code 对应项,和 `readByDefault` 一样不取 Claude Code 默认值。`ownMemory: false` 时不注册工具、不注入自己的段,`dsh` 来源也从读取开关和菜单里消失。
- **写不是会话级开关**:`ownMemory: true` 时自己的段始终注入;会话里只能按来源决定读不读([按来源的读取开关](2026-10-26-session-memory-toggle.md)),`dsh` 读关着时该段只给目录和规则、不 stat 索引,并要求写前先读索引去重。
- `~/.claude` 仍然永远只读,注入文本继续要求模型不创建、修改、删除那里的文件,也不复制那边已有的条目。

## Alternatives considered

- **写进 Claude Code 的同一个目录。** 一份记忆两个宿主共享,查重和互链都在一处;Claude Code 自己的多个并发会话也在往同一个 `MEMORY.md` 追加,格式本身容忍多写者。用户选择不碰 Claude Code 的地盘:两边各自演进(元数据字段、索引格式)时不会互相污染,也不用担心 Claude Code 的清理或迁移把 dsh 写的条目当异物处理。代价是记忆分家,注入文本要求模型写前查两个索引。
- **模型用普通文件工具写,插件不写文件。** 最少宿主接口,Claude Code 自己也是模型用 Write 写、宿主事后补元数据。被文件沙箱否决:默认 `workspace-write` 下 `~/.dsh` 不可写,每次都要审批,headless 完全不可用;而且模型可能顺着"更新/删除"的写规则改到 `~/.claude`,索引并发写有 lost update,frontmatter 写坏插件也不知道。工具路径一次解决这四件事。
- **把 own store 放进 workspace(如 `<repo>/.dsh/memory/`)。** 沙箱直接放行。会把记忆提交进仓库或要求每个仓库改 `.gitignore`,worktree 之间也不共享;Claude Code 把记忆放在仓库外正是为此。
- **给 dsh 加可写根白名单。** 最干净。要改 dsh 主仓库,违反本项目"不碰 dsh 主仓库"的边界。
- **两条独立消息、两个投影。** 每个存储单独去重、单独撤回。投影状态和 `sourceEventSeqs` 判定要翻倍,而两个索引一起变化时还是两次注入;合成一条消息后 digest 一次搞定。
- **own store 的读定位也沿用多候选顺序。** 能命中旧版按 worktree 路径建的目录。可本插件的 own store 没有旧版,而且读到非规范目录、写到规范目录会让模型看到的索引和它该追加的索引不一致。
- **没有条目时不注入自己的段。** 省几百 token。模型就不知道目录在哪、该怎么写,第一条记忆永远写不出来。
- **own slug 用无损编码避免 `/a-b` 与 `/a/b` 碰撞。** 目录名难读,与 Claude Code 的目录对不上;碰撞概率极低且 Claude Code 自己也接受。记为已知上限。

## Consequences

- **收益**:dsh 会话能把用户纠正和项目约束留到下一个会话;所有 worktree、符号链接入口共用一份;写入不经沙箱审批,headless 也能写;元数据由宿主填,索引由持锁的写者维护;模型没有任何路径能改到 `~/.claude`。
- **代价与已知上限**:多用两个宿主接口——`ctx.tools.register`(可选注入;宿主没有 `tools`、或 tools 作用域已卸载——注册标记由 `toolCtx.effect` 的 disposer 在作用域释放时复位——时每会话警告一次,自己的段改说"本宿主无法写入"、不给工具规则)和 `ctx.get('sandboxPolicy')`(可选;存在且会话策略为 `read-only` 时工具拒绝写,与 Claude Code 在只读会话里写不了记忆一致);子代理在 `includeSubagents` 关着时调用工具被拒,与 Claude Code 不给子代理记忆一致;开着 own store 的每个有 cwd 的会话第一步都多一条几百 token 的消息,即使项目没有任何记忆;模型会把查重做在两个索引上;slug 碰撞同 Claude Code(`/a-b` 与 `/a/b` 同目录,own store 可写时误改另一项目条目的后果更重,接受为已知上限);`--separate-git-dir` 的仓库从 worktree 里定位不到主仓库(git 自己也存不下这个指针),own store 落在 worktree 自己的路径下,独立 git 目录恰好叫 `.git` 时则落在该目录的父目录,与 `git worktree list` 的报告一致;工具只校验 `name`、`type` 和各字段非空,正文质量和长度仍靠模型;文件与索引两次写入不是事务,索引写失败会留下孤儿文件;同名条目两处同时 `memory_save` 时后写的赢;锁等待 10 秒后工具报错;进程在接管互斥持有期间(毫秒级窗口)被杀,留下的 `.takeover` 文件要等 10 秒后才会被清掉;一个进程被冻结超过 10 秒(心跳停了)再恢复写入,会与接管者重叠,这是无 `flock` 的文件锁的固有上限。

## Verification

`test/store.test.js` 覆盖名字校验、frontmatter 渲染、索引行 upsert/remove(按行首链接目标识别、hook 里的假链接不算、尖括号转全角、无尾换行文件、只剩空索引)、`saveMemory`/`deleteMemory` 的创建/更新/删除与临时文件清理、八路并发写全部落索引,以及在真实 `ToolRuntime` + `SessionStore` 上挂载后通过 `ctx.tools.execute` 调用两个工具:schema 参数与 `type` 枚举、落盘路径与 `originSessionId`、索引接近上限提醒与超限返回错误(文件仍写入)、`judgeIndex` 的三档边界、非法 name、非法 type、无会话调用报错、删除已存在与不存在的条目、从 linked worktree 写到主仓库目录、`ownMemory: false` 不注册。`test/locate.test.js` 覆盖 `canonicalRoot`、`locateOwnIndex`(含 `stat: false`)、`renderMemoryMessage`(完整性声明只及展示的索引、只读段文案、工具规则、未加载段、索引上限、按段标截断)和 `mainRootOfWorktree` 与 `git worktree list` 的一致。`test/plugin.test.js` 覆盖:没有任何记忆时注入目录与规则;两个索引合成一条 snapshot;写入后下一轮重注;Claude Code 索引消失或关掉只少一段、不撤回;空 own 索引当作无条目、不可读时降级且 Claude Code 段仍在;`dsh` 读关着时不读索引;worktree 与主仓库命中同一目录;`ownMemory: false` 只剩 claude 来源且拒绝 `dsh`;相对 `ownMemoryHome` 警告并关掉 own store;无 `tools` 宿主的段文案与一次警告;工具拒绝子代理、read-only 会话和空字段;own 定位失败不撤回;`~/` 展开。`test/locate.test.js` 另覆盖恰好 200 行的索引不算截断、截断索引不声称完整、索引文本里的闭合标签被中和、无工具时的段文案。`test/store.test.js` 另覆盖保留名 `memory`(存删都拒、索引不动)、两进程各存 20 条索引 40 行、遗弃锁接管、裸 CR 折叠、任意列表标记与重复行折叠;`test/plugin.test.js` 另覆盖 own 定位失败时连 Claude Code 段也不进入、截断的空白窗口不算空、工具半套注册回滚、read-only 会话的段文案。锁另有确定性测试:四路争抢同一遗弃锁十轮零重叠、持有者超过 stale 窗口不被接管、释放不删他人 token、两进程加预置遗弃锁三轮各 40 行;真实 Cordis 卸载 `ToolRuntime` 后下一条消息改说无工具。`npm test` 89 条全过。
