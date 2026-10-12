---
name: dsh-trim-cot-leakage
description: Use when auditing or fixing prose that reads like a leaked reasoning transcript — dead design-session citations such as (decision N), audit item codes, or §N of uncommitted drafts; change narration such as "used to", "no longer", "this cut", "不再", "旧版"; stack or review vantage ("a later PR", "rejected in review"); reviewer-addressed justifications; control-flow narration; or hedged planning residue in comments, docstrings, docs, or Agent Notes.
---

# 去推理痕迹（Trim Chain-of-Thought Leakage）

> 搬自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh-trim-cot-leakage` skill。去掉了双语配对与生成目录的修复路径。它是指导，不是脚本。

推理泄漏是**站在写作会话、而不是仓库视角**写出来的散文：引用只有那次会话看得见的东西，叙述变更而不是状态，或者在和一个已经离开的评审者争辩。修法从来不是单纯删除——段落里有事实从句的，先把每条重述成在 HEAD 独立成立的样子，再删掉周围的记录；没有事实从句的（审计编号、控制流叙述）直接删。必读背景：[dsh-prose-standard](../dsh-prose-standard/SKILL.md) 拥有本 skill 所应用的完整命题规则。

## 唯一的判据

对每个可疑段落问：**一个在 HEAD 的读者，拿不到任何会话记录、PR 讨论或未提交草稿，能解析每个引用、验证每个断言吗？** 不能，就从仓库视角重述幸存的事实，删掉其余。能，就不是泄漏，不管它听起来多像历史——但可解析只过了本 skill 这一关：在当前状态面（README、docs、docstring）上，可解析的变更故事仍是变更叙述，按第 3 类路由到它该去的地方（Agent Note 的变更章节、PR、issue）。

## 分类

1. **死的设计会话引用**——`(decision 7)`、`(audit C2)`、`设计 §4.7`、`plan §1.4`、阶段标签（`T4`、`W3`、`P-I`）、"设计台账"、"（B 裁定）"。决定有已提交的所有者就按名字和路径引用；否则删引用，把它的事实从句重述为独立成立。
2. **栈与 PR 视角**——"后续 PR"、"本 PR 新增"、"上一个 commit"。写已交付的机制或扩展点；推迟的工作移到 `TODO` 标记或 issue 引用。
3. **变更叙述与版本戳**——"used to"、"不再"、"旧的 X"、"以前"、索引式的戳（"v1"、"this cut"、"本版"、"today"、与过去对比的"now / 现在"）。写现在的行为；修好的回归写成现在时反事实（"没有 X 就会 Y"），绝不写成仓库历史（"以前会 Y"）。
4. **评审编排**——"评审时否掉："、"reviewer 确认了"、草稿序号（"本笔记 v5"）、轮次归属。保留幸存的决定和理由作为平实事实；删掉谁在什么时候说的。
5. **对评审者的辩护**——"这个 cast 是安全的——它只是…"、"这是对的，因为…"。论证自身正确性的注释在对评审者说话，不是对维护者。写出让代码安全的不变量；代码已经显示它就删注释。
6. **复述与推导记录**——控制流叙述（"先 X 再 Y"）、测试走读、显然分支的证明。删；只留非显然的契约或不变量。
7. **含糊与计划残留**——"大概够了"、"should be enough"、没有标记的推迟。升级为 `TODO` / `FIXME` 或写成实际的边界；删掉含糊。
8. **工作语言串台**——英文散文里的未翻译中文片段（端、设计稿、`---- 私有 ----` 分隔符），或中文散文里的英文工作语言碎片。翻译或删除。

## 什么不是泄漏

无辅助的引用清理会双向出错：删掉持久引用、留下死引用。按写明的保留规则执行，[references/examples.md](references/examples.md) 逐条校准：

- **Issue 引用**——`#1470`、`TODO(name):`、"issue #N 负责后续"在 HEAD 可解析；任何面都保留，包括 README。
- **Agent Note 与复盘里的已合并 PR 引用**——这两种文体允许引用 PR 作为证据。
- **抑制理由**——`eslint-disable … -- 原因`、coverage-ignore 原因、空 catch 的解释是必需散文；理由错了就改，永远不删。
- **现在时反事实的回归钉**——"没有 X 就会 Y"、"朴素的 X 会…"。
- **实测边界**——"(measured: 512 nests ≈ 0.15s)"校准一个常量；"实测 / measured"这个词是承重的。
- **运行时的 old / new**——"旧连接排空后新连接才接受"是运行时生命周期，不是变更历史。
- **笔记变更章节里的历史阶段名**——"第一版交付了 X"在 Agent Note 的变更叙述节里是当前状态安全的；索引式的"本版 / this cut"在哪里都禁。
- **按设计解析到仓库外的引用**——标准条款（RFC 9110 §10.1.5）、Figma 帧名；§ 禁令针对未提交的内部草稿，不针对外部标准或自带 § 编号的已提交文档。
- **项目口吻与文体形式**——作为项目口吻的"我们"；Agent Note 的"备选方案"节。

## 流程

1. 范围与排除按 [dsh-prose-standard](../dsh-prose-standard/SKILL.md)：要求明确的 scope；永远不碰 `.agents/notes/archived/`。录制的 fixture 和快照是派生物，不是散文目标。
2. 先只读审计：跑 [references/recall-batteries.md](references/recall-batteries.md)（带 `--hidden` 以搜到 `.agents/`），每个探针先对一个已知阳性和一个近似阴性校准再信它的输出，然后对每个命中做语义判断。探针是辅助不是定义——每轮评审都会发现探针漏掉的情况，所以也要不带模式地通读范围内最密的散文（模块文档、README、Agent Notes）。
3. 按面从源头修：生成产物 → 追每个消费者，改源头再重新生成；模型或用户可见的字符串 → 走 [dsh-prose-standard](../dsh-prose-standard/SKILL.md)，只在有拥有它的行为证据时改，否则不动并报告推迟。
4. 删任何东西之前，列出段落的命题（prose-standard），对照 [删过头的坑](references/examples.md#删过头的坑)：把义务翻成背书、把假设提成已交付、删掉真事实、丢掉证据来源。
5. 验证：重跑探针，预期只剩允许保留的项和本 skill 自己的目录；确认每个剩余引用在 HEAD 可解析；跑被碰到的面的门禁（`verify-md-links`、notes 三条）。
