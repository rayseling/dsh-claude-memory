---
name: dsh-layer-instructions
description: Use when bootstrapping a new project or repository with these skills, when creating or editing AGENTS.md / CLAUDE.md, adding a rule for coding agents, deciding where an instruction belongs (root, directory, skill, or linked doc), or when an instruction file grows past its word ceiling. Owns the one-time setup order (AGENTS.md, gates.json, escape-hatches.json, doc-budgets.json, lefthook) and keeps the root file one screen of self-contained linked rules enforced by verify-doc-budgets.
---

# 指令分层（Layer Instructions）

> 搬自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `AGENTS.md` 结构与 `scripts/verify-doc-budgets.ts`。目标只有一个：agent 每次只读到与手头事相关的那一层，而且永远读得完。

## 为什么要分层

每个新会话都读根 `AGENTS.md`。规则越积越多就会出现两种失败：读不完，或者读到的大多与当前目录无关。DSH 的解法不是写得更少，而是**每条规则放在它被需要的那一层**，根文件只留跨仓库的一句话结论加链接，并用字数门禁阻止回涨。

## 四层，各放什么

| 层 | 文件 | 放什么 | 不放什么 |
|---|---|---|---|
| 根 | `AGENTS.md`（`CLAUDE.md` 为其符号链接） | 仓库是什么、布局、命令、每条跨仓库规则**一句话 + 链接** | 细则、理由、示例、历史 |
| 目录 | `<dir>/AGENTS.md` | 进到该目录才需要的规则 | 根已写过的规则 |
| 任务 | `.agents/skills/<name>/SKILL.md` | 做某类任务的完整流程（评审、推送、归档、写升级指南） | 日常不触发的背景知识 |
| 文档 | `docs/*.md`、`README.md`、Agent Note | 细则、理由、备选方案 | 必须每次会话都知道的硬规则 |

规则：**一个事实只在一处讲透，其余层链过去**。根文件的每条规则都必须自含（不点链接也能执行）并带一个指向细则或理由的相对链接。

`CLAUDE.md` 用符号链接：`ln -s AGENTS.md CLAUDE.md`。多层目录各自链接各自的（DSH 在根和 `packages/` 各一份）。Codex、Cursor、Claude Code 都读 `AGENTS.md`，只有 Claude Code 额外读 `CLAUDE.md`，所以 `AGENTS.md` 是真身。

## 规则怎么写

每条一行，结构固定：**加粗结论** + 一句执行要点 + （链接）。

```markdown
- **注册即副作用**：每个贡献都走 `ctx.effect()`，注册函数返回销毁器（[语义](docs/architecture.md#effects)）。
```

写之前问三件事：

1. 这条规则有门禁吗？没有就先去 [dsh-gate-every-rule](../dsh-gate-every-rule/SKILL.md) 补门，再写规则；写在散文里又没有门的规则，对 agent 等于不存在。
2. 它是跨仓库的吗？不是就下沉到目录 `AGENTS.md` 或 skill。
3. 它的理由在哪？放 Agent Note 或 docs，这里只链。

## 字数门禁

`.agents/doc-budgets.json` 列出每个常设指令文件的字数上限（模板见 `templates/doc-budgets.json`）：

```sh
npx tsx .agents/skills/dsh-layer-instructions/scripts/verify-doc-budgets.ts          # 超限即红
npx tsx .agents/skills/dsh-layer-instructions/scripts/verify-doc-budgets.ts --list   # 看当前用量
```

- 上限只能向下调；向上调必须在同一次改动里写明理由。
- 文件改名或删除时同批更新 manifest，否则门禁报 `MISS`。
- 中文按字计、英文按词计，取较大者。
- 把它接进 `npm run gates`（见 [dsh-gate-every-rule](../dsh-gate-every-rule/SKILL.md)）。

超限时的处理顺序：先删重复 → 再把细则下沉到链接目标 → 最后才考虑提上限。

## 落地步骤

1. 没有 `AGENTS.md`：从 `templates/AGENTS.root.md` 起草，按仓库实际删改；建 `CLAUDE.md` 符号链接。
2. 已有 `AGENTS.md`：按上表逐条分流——细则下沉、理由链到 Agent Note、没有门禁的规则标记待补。
3. 目录级规则用 `templates/AGENTS.dir.md`，只在那个目录确有自己的规则时才建。
4. 建 `.agents/doc-budgets.json`，上限取当前字数向上留 5% 余量，接入门禁。

## 新项目启动（一次性）

八个 skill 装好后，在仓库根目录按顺序做完，再开始写代码。需要判断的步骤（起草 `AGENTS.md`、选逃生口模式、定上限）由 agent 对照项目完成，不做成脚本。

**先探测，别造第二套。** 宿主已有的东西沿用，skill 只补缺的部分：

- 已有 `AGENTS.md` / `CLAUDE.md` → 不换模板，按「落地步骤」分流；它已有字数门禁且打满时，新规则靠下沉旧内容腾位置，不是加字。
- 已有门禁聚合器（`scripts/check.mjs`、`make check`、`pnpm run gates` 之类）→ **不建 `.agents/gates.json`、不装 lefthook**，把本套的 `verify-*` 脚本作为新条目挂进现有聚合器；两套并行的门禁是最先腐化的那种重复。
- 已有笔记目录（`notes/`、`docs/adr/`）→ 不建 `.agents/notes/`，设 `AGENT_NOTE_ROOT` 指过去，与生命周期无关的旧文件夹用 `AGENT_NOTE_IGNORE` 点名（[write-notes-like-deepseek §6](../write-notes-like-deepseek/SKILL.md#6-校验与运维命令)）。
- 已有 hook 管理（husky、lefthook、pre-commit）→ 往现有配置加条目，不复制 `templates/lefthook.yml`。

1. **前提**：git 仓库；Node ≥ 20。Node ≥ 23.6 可用 `node` 直接跑下面所有 `.ts`；仓库的 `node_modules` 是符号链接时 `npx tsx` 会失败，也用 `node`。
2. **根指令**：复制 `templates/AGENTS.root.md` 为 `AGENTS.md`，按项目删改「布局」「命令」「约定」三节——只留这个仓库真有的规则和真能跑的命令；`ln -s AGENTS.md CLAUDE.md`。
3. **门禁配置**（都放 `.agents/`）：
   - `cp .agents/skills/dsh-gate-every-rule/templates/gates.json .agents/gates.json`；用 `node` 的项目把其中 `npx tsx` 换成 `node`。
   - `cp .agents/skills/dsh-gate-every-rule/templates/escape-hatches.json .agents/escape-hatches.json`；按语言删改 `patterns` / `extensions`（纯 JS 删 `as-unknown` / `as-any`，无 Python 删 `py-*`）。
   - `.agents/doc-budgets.json` 先只列 `AGENTS.md`，上限填当前字数 +5%（`verify-doc-budgets.ts --list` 看字数）。
4. **基线与首跑**：`verify-escape-hatch-baseline.ts --init`，然后 `run-gates.ts` 必须全绿。
5. **本地 hook**（推荐）：`cp .agents/skills/dsh-gate-every-rule/templates/lefthook.yml lefthook.yml`，`npm i -D lefthook && npx lefthook install`，`package.json` 加 `"postinstall": "lefthook install"`；按项目填 lint / typecheck 行。
6. **CI**：把 `run-gates.ts` 作为唯一入口接进 pipeline（[dsh-gate-every-rule](../dsh-gate-every-rule/SKILL.md#接入-ci)）。
7. **提交**：`chore: bootstrap agent skills and gates`，并把 `skills-lock.json` 一起提交。

之后第一个非平凡改动按 [write-notes-like-deepseek](../write-notes-like-deepseek/SKILL.md) 立第一篇 Agent Note；已有设计决策散在 `AGENTS.md` 里的存量仓库，把它们拆成 `implemented/` 笔记，根文件只留链接。
