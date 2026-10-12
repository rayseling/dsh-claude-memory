---
name: dsh-layer-instructions
description: Use when creating or editing AGENTS.md / CLAUDE.md, adding a rule for coding agents, deciding where an instruction belongs (root, directory, skill, or linked doc), or when an instruction file grows past its word ceiling. Keeps the root file one screen of self-contained linked rules and enforces ceilings with verify-doc-budgets.
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
