---
name: dsh-prose-standard
description: Use when writing, reviewing, trimming, restoring, or auditing prose anywhere in a repository — Markdown docs, READMEs, JSDoc, code and test comments, prompts, tool descriptions, diagnostics, CLI/UI strings, Agent Notes — including deciding where a comment or doc is required and where it must be deleted. Preserves every factual clause; removes reasoning transcripts, repetition, and decoration.
---

# 散文标准（Prose Standard）

> 搬自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh-prose-standard` skill 与其 `AGENTS.md` 的"Type safety and documentation"一节。去掉了 DSH 特有的 vendor 排除、双语配对、生成目录与 UI i18n 门禁。它是编辑判断，不是脚本。

写到足以保住契约，然后删掉推导过程、重复和装饰。**契约**指调用方、被调方、实现者、生产者或消费者所依赖的义务、不变量、前置/后置条件或兼容承诺。寻找会话痕迹用 [dsh-trim-cot-leakage](../dsh-trim-cot-leakage/SKILL.md)。

`契约 / 边界 / 形态 / 表面 / 接缝 / 门禁 / 词汇` 这类词用前先问：有没有更准确的名词——具体的规则、API、字段集、类型、校验、时序点、组件划分、失败状态？只有当它就是那个技术主体时才保留（调用契约、安全/进程边界）。

注释描述代码表达不了的非显然契约或理由，不复述代码已经隐含的事。

## 输入

- 要求明确的 `scope`；没有就报告缺输入并停下，不自行扩大到全仓。
- `mode: automatic | interactive`，默认 automatic。只在用户明确要提问或校准时进 interactive。
- `mode` 管提问，不管写权限：review / audit 只报告不改；明确要求 write / fix / trim 时才应用清晰的修改。
- 永远不碰 `.agents/notes/archived/`（冻结快照）。生成产物（目录、快照、fixture）是派生物：改它的源头再重新生成。

## 保住完整命题

动笔前先列出段落里的每个命题，逐一保留相关的：

- 主体与动作；
- 条件、时序、顺序；
- 情态：must / may / never；
- 否定保证与例外；
- 所有权、副作用、失败模式、后果。

只在每个事实从句都幸存且结果更清楚时才删形容词、重复和叙述。**字数变少本身不是改进。**

在使用点保留完整的本地契约：调用方或维护者在那里需要的行为、失败、所有权、后果。架构、理由、算法、历史、扩展示例**积极链接**到拥有它的文档。一个解释只有一个家；关键契约事实可以在本地重复。

省略理由可能导致误用或错误简化时保留理由；否则只写后果并链接理由的家。

## 各位置的必需覆盖

这不是单向的压缩。当代码、类型、结构没有传达下列契约时，**补上或恢复**散文；它们已经在本地显然时，不加注释。

- **公共 JSDoc / docstring**：调用方可见的返回区分、throws / rejects、副作用、所有权、时序、取消、持久性。函数类导出写 `@param` / `@returns`。
- **内部注释**：定位非本地的结构和明显复杂的本地结构——不变量、竞态顺序、所有权、安全边界、意外的失败行为。删控制流叙述和代码复述。
- **模块注释**：模块的角色、依赖、职责、非显然的架构选择；架构选择链接到它的解释。
- **测试**：只解释非显然的测试设计——为什么需要这个 fixture、断言、平台适配、真实入口或间接观察。删走读和清单。
- **操作指南**：前置条件、必需动作、真实入口、可观察的验证、简短警告。
- **README**：消费者契约——配置、语义、失败、限制、扩展点、模型可见效果。保留持久的缺口和维护者陷阱，不是普通的清理清单。
- **Agent Notes**：保留独特的理由、机制、备选、后果、已交付的验证证据、点名的覆盖缺口。implemented 用现在时写已交付的现实；删计划清单，不删钉住决定的证据。
- **复盘**：保留事故序列、证据、因果链、影响、预防。删重复的说服和不建立因果的实现细节。
- **Skill 与 agent 指令**：写明行为护栏和明确的范围限制（"是指导不是脚本"）。流程简洁，链接事实来源。
- **示例与配置注释**：解释访问限制、非显然的接线或加载顺序、安全立场、回放行为、例外、可能的误用。不复述配置已经显示的条目。
- **提示词与可见字符串**：措辞即行为。文本、无障碍名称、tooltip、占位符、格式模板一起看；改动要有拥有它的快照或行为证据，没有就不改并报告推迟。
- **诊断**：点名失败的主体或路径、违反的规则、非显然时的修正。删内部执行叙述。

保留可检索的机制名和有意义的情态、时序、否定强调。只规范化装饰性强调。

## 流程

1. 确认 scope、mode、当前分支或 PR 基线、适用的 `AGENTS.md`。不看无关分支。
2. 先读拥有该段落的代码或文档，再判断。校准或不熟的情况读 [references/examples.md](references/examples.md)。
3. 检查请求的全部范围，不只是最大的文件。用搜索和字数找候选，再按语义判断段落。
4. 把每个候选归为 keep / add / trim / restore / restructure / defer。只在任务授权编辑时应用清晰的修改；不为凑删除量制造修改。
5. 先改源头再改派生物。学到一条新规则后重查同类段落。
6. 跑窄的相关检查：文档门禁、`git diff --check`、可见字符串的行为测试。
7. 报告检查过的范围、清晰的修改、刻意保留的、推迟的、实际跑过的检查。

## 边界情况

只有当至少两个版本都满足完整命题规则、但在已接受的原则间取舍、且本 skill 没有解决这个取舍时，才算边界情况。只有一个保命题答案的改写不是边界。

automatic 模式：授权时应用清晰的修改，报告真正的边界情况而不提问。不为推进而削弱命题。

interactive 模式：把同类段落按支配原则分组，给两到三个可行版本，推荐一个，说明事实或结构上的差异。不给劣质的陪跑选项。用户决定后，把原则和版本蒸馏进 [references/examples.md](references/examples.md)（不含 PR 历史或评审叙述），并应用到范围内所有同类段落。
