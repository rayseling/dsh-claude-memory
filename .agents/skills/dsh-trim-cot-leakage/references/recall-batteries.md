# 召回探针

> 搬自 DeepSeek Harness `dsh-trim-cot-leakage/references/recall-batteries.md`。探针对应 [分类](../SKILL.md#分类)；每个命中都需要语义判断——探针按设计过度匹配，又天然漏匹配，所以要配合不带模式地通读范围内最密的散文。

## 调用规则

- 加 `--hidden --glob '!.git/**'` 让 ripgrep 搜到 `.agents/`；它默认跳过点目录，而最容易漏的正是 Agent Notes。
- 排除放最后，免得后面的 include 把它们放回来：`--glob '!node_modules/**' --glob '!.agents/notes/archived/**' --glob '!.agents/skills/dsh-trim-cot-leakage/**'`（本 skill 的文件引用泄漏措辞作校准），再加范围内的录制 fixture 和快照目录。
- 自然语言行带 `-i`，让句首大写也命中（"This PR adds…"）；第一行匹配代码样式的模式保持大小写敏感——`-i` 会把 `\bT\d\b` 和 `\bP-I\b` 变成噪声。
- 匹配完整短语。`\bthis PR\b` 要命中 "this PR adds" 而不命中 "this project"、"this process"。
- 零命中的模式在命中一个已知阳性之前证明不了任何事；噪声模式在拒绝一个近似阴性之前也证明不了任何事。两者都先校准再信语料结果。
- 工作语言探针对准相反语言的面：在英文 Markdown 和代码注释里搜中文残留，在中文散文里搜中文变更叙述。对中文散文做泛 ASCII 搜索在代码和标识符周围太吵，改为对照改动前后的散文差异。

## 英文探针

```sh
rg -n --hidden '\(decision \d|\(audit [A-Z]\d|design §|plan §|design ledger|\(B ruling|\bP-I\b|\bW\d\b|\bT\d\b' ...
rg -n --hidden -i '\bthis PR\b|\bthis branch\b|\bthis stack\b|\blater PRs?\b|\bprevious commits?\b|\bthis commit\b' ...
rg -n --hidden -i '\bused to\b|\bno longer\b|\bpreviously\b|\bthe old\b|\bwas renamed\b|\bwas moved\b' ...
rg -n --hidden -i '\bv1\b|this cut|\bcut \d|\btoday\b|\bfor now\b|roadmap' ...
rg -n --hidden -i 'rejected in review|review round|reviewer|as of v\d' ...
rg -n --hidden -i 'probably |should be enough|should suffice|it simply|is safe —|is safe --' ...
rg -n --hidden '§\d' ...
```

## 中文探针

```sh
# 中文散文里的变更或评审叙述。
rg -n --hidden '评审时|上一?轮|旧版|老的|不再|以前|本版|遗留|本 PR|后续 PR|decision \d' --glob '*.md' ...

# 英文 Markdown 里的中文工作语言残留。
rg -n --hidden '设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有|(^|[^a-zA-Z])端([^a-zA-Z]|$)' --glob '*.md' --glob '!*.zh.md' ...

# 英文代码注释里的中文残留。
rg -n --hidden '(^[[:space:]]*(//|/\*|\*)|//|/\*)[^\r\n]*(设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有|端)' --glob '*.{ts,tsx,js,jsx,mjs,cjs,css}' ...
rg -n --hidden '#[^\r\n]*(设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有|端)' --glob '*.py' ...
```

## 已知的假阳性家族

清理时判断过并保留的，预期还会再遇到：

- **工具性的 "used to"**——"the key used to sign requests" 是工具性的不是时间性的。时间性形式前面有一个主体状态（"colors used to come from…"）。
- **运行时的 old / new**——"旧连接排空后新连接才接受"命名交接期间的活对象，不是仓库状态。
- **流程文档里的 "this PR"**——*关于* PR 流程的文档（"PR 正文应该…"、模板、流程笔记）合法地说 "PR"；禁的是某篇文档采用某一个 PR 的视角谈代码。
- **作为协议或路径段的 `v1`**——`/v1/chat` 端点和线格式名是标识符，不是版本戳。
- **有已提交所有者的 `§N`**——外部标准（RFC 9110 §10.1.5）和自带 § 编号的已提交文档可以按节引用。
- **运行时的"今天"和录制的时间戳**——询问当前日期的提示词或测试用的是自然时间，不是仓库版本戳；录制的 CLI 输出保留它的口吻。
- **"本版本"**——在版本化产物语境里是 "this release" 的合法译法；禁的是作为裸戳的"本版"，对应 "this cut"。
- **备选方案节**——Agent Note 文体槽里的"否决"是被允许的家，不是评审编排。
