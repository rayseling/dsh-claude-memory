# Agent Note: dsh 自己的记忆目录,模型写、插件只读

Status: implemented

## Problem

插件只把 Claude Code 维护的索引注入 dsh 会话,dsh 会话里学到的事(用户纠正、项目约束、外部链接)没有地方落,下一个会话又得重新问。用户要求 dsh 也能记录记忆。[只注入索引、对记忆只读](2026-10-12-index-only-read-only.md) 的理由是两个宿主共写一份记忆会冲突、单一写者最简单;它并没有说 dsh 不能有自己的一份。

## Decision

dsh 有一个自己的记忆目录,格式与 Claude Code 完全一致,由模型用普通文件工具写,插件进程仍不写任何文件。

- **位置**:`<ownMemoryHome>/<slug>/`,默认 `~/.dsh/memory/<slug>/`,索引是 `MEMORY.md`,条目一文件一事实,frontmatter 为 `name` / `description` / `metadata.type`(`user | feedback | project | reference`),正文带 `**Why:**` / `**How to apply:**` 和 `[[name]]` 互链。`slug` 用与 Claude Code 相同的 `slugOf`。
- **只有一个目录**:slug 取自 `canonicalRoot(cwd)`——linked worktree 的主仓库,否则 git 根,否则工作目录本身,全部按真实路径。它与 [Claude Code 索引的多候选定位](2026-10-12-memory-directory-location.md) 不同:读 Claude Code 的索引可以试多个候选,写自己的记忆必须收敛到一处,否则两个 worktree 会各写一份。
- **一条消息、两个段落**:Claude Code 索引段(只读,规则不变)在前,自己的段在后;digest 覆盖整条消息,[snapshot 替代语义](2026-10-12-snapshot-replacement-and-withdrawal.md) 不变。配了 own store 时自己的段始终存在,没有条目也要告诉模型目录在哪、怎么写,因此纯撤回消息只在 `ownMemory: false` 时才会出现;Claude Code 索引消失或被关掉只是下一条消息少一段,"完整替代此前索引"的声明已经覆盖这种情况。
- **写入规则随消息注入**(`renderMemoryMessage`):记什么、不记什么、写前先查两个索引去重、文件格式、写完给索引加一行、索引只放指针。规则按 Claude Code 系统提示里的记忆规则改写,放在动作之前。
- **写了就会回灌**:模型写完文件和索引行,下一轮第一步 size/mtime 变了就重读、重注入,不需要新接口。
- **配置**:`ownMemory`(默认 `true`)和 `ownMemoryHome`(默认 `~/.dsh/memory`,支持 `~/`)。它们没有 Claude Code 对应项,和 `readByDefault` 一样不取 Claude Code 默认值。
- **写不是会话级开关**:`ownMemory: true` 时自己的段始终注入;会话里只能按来源决定读不读([按来源的读取开关](2026-10-26-session-memory-toggle.md)),`dsh` 读关着时该段只给目录和规则,并要求写前先读索引去重。
- `~/.claude` 仍然永远只读,注入文本继续要求模型不创建、修改、删除那里的文件。

## Alternatives considered

- **写进 Claude Code 的同一个目录。** 一份记忆两个宿主共享,查重和互链都在一处;Claude Code 自己的多个并发会话也在往同一个 `MEMORY.md` 追加,格式本身容忍多写者。用户选择不碰 Claude Code 的地盘:两边各自演进(元数据字段、索引格式)时不会互相污染,也不用担心 Claude Code 的清理或迁移把 dsh 写的条目当异物处理。代价是记忆分家,注入文本要求模型写前查两个索引。
- **插件进程代写(观察工具调用或提供写记忆工具)。** 能补 `originSessionId` / `modified` 这类元数据。要多用宿主接口(工具注册或工具结果钩子),违背"六个接口"的约束;Claude Code 自己也是模型用 Write 写、宿主事后补元数据,这里把元数据省掉,格式仍兼容。
- **两条独立消息、两个投影。** 每个存储单独去重、单独撤回。投影状态和 `sourceEventSeqs` 判定要翻倍,而两个索引一起变化时还是两次注入;合成一条消息后 digest 一次搞定。
- **own store 的读定位也沿用多候选顺序。** 能命中旧版按 worktree 路径建的目录。可本插件的 own store 没有旧版,而且读到非规范目录、写到规范目录会让模型看到的索引和它该追加的索引不一致。
- **没有条目时不注入自己的段。** 省几百 token。模型就不知道目录在哪、该怎么写,第一条记忆永远写不出来。

## Consequences

- **收益**:dsh 会话能把用户纠正和项目约束留到下一个会话;所有 worktree、符号链接入口共用一份;插件进程仍不写文件,出错面没变。
- **代价与已知上限**:开着 own store 的每个有 cwd 的会话第一步都多一条几百 token 的消息,即使项目没有任何记忆;模型会把查重做在两个索引上;`ownMemoryHome` 下的文件没有 `modified` / `originSessionId`,靠正文里的绝对日期;模型写坏 frontmatter 或忘了加索引行时插件不校验,只会在下一轮原样注入。`--separate-git-dir` 的仓库从 worktree 里定位不到主仓库,own store 落在 worktree 自己的路径下。

## Verification

`test/locate.test.js` 覆盖 `canonicalRoot`(普通目录、子目录、符号链接、linked worktree、非 worktree 的 `.git` 文件)、`locateOwnIndex`(目录不存在、索引是文件、索引是目录)和 `renderMemoryMessage`(两段、只读段在前、只有 Claude、只有空 own、按段标截断)。`test/plugin.test.js` 覆盖:没有任何记忆时注入目录与规则;两个索引合成一条 snapshot;模型写入后下一轮重注;Claude Code 索引消失只少一段、不撤回;空 own 索引当作无条目、不可读时不注入;worktree 与主仓库命中同一目录、digest 相同;`ownMemory: false` 回到只注入 Claude Code 索引;`~/` 展开。`npm test` 60 条全过。
