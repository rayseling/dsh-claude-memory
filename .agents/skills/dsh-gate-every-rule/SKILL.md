---
name: dsh-gate-every-rule
description: Use when adding a rule to AGENTS.md or a skill, when a review finds agents ignoring a written convention, when wiring verify-* scripts into one gate runner or git hooks, or when a type-system escape hatch (as unknown, @ts-ignore, Python type-ignore) count must only decrease. Every rule gets a script that rejects a known-bad case; prose alone is not a rule.
---

# 规则必有门（Gate Every Rule）

> 搬自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `scripts/run-gates.ts`、`verify-md-links.ts`、`verify-no-unknown-casts.ts`、`lefthook.yml` 与其 `AGENTS.md` 的一条元规则："Wire mechanically checkable invariants into an executed top-level gate and prove each changed acceptance path rejects an invalid case."

## 公理

**agent 遵守被强制的门，远胜于遵守散文式约定。** 一条规则写进 `AGENTS.md` 而没有脚本撑腰，agent 在压力下必然跳过；而干活的劳动力已经是 AI，"写门禁太麻烦"不再成立。

推论：**每提一条新规则，同一次改动里交两样东西——一道 `verify-*` 门，和一个它能拒掉的反例。** 拒不掉反例的门不算门。

## 门长什么样

- 一个零依赖脚本，`npx tsx` 直接跑，从宿主根目录读当前目录；通过打印一行 `ok`，失败逐条打印 `文件:行 — 违反了什么 — 怎么修`，非零退出。
- 只查能机械判定的事：路径、头块、字数、链接可解析、计数不涨、文件存在。语义判断（"备选方案够不够真"）留给 skill 清单，不做成门。
- 不做全局豁免：需要例外就把例外写成**窄而有理由**的白名单条目，不关规则。
- 失败要响亮：配置缺失、manifest 格式错、引用的文件不存在，都直接红，不静默跳过。

## 三道通用门（本 skill 自带）

| 脚本 | 查什么 | 对应 DSH |
|---|---|---|
| `verify-md-links.ts` | 全仓 Markdown 相对链接与 `#锚点` 可解析；归档区不作为源但可被链 | `verify-md-links.ts`（去 mdast 依赖） |
| `verify-escape-hatch-baseline.ts` | `as unknown` / `@ts-ignore` / `# type: ignore` 等逃生口按文件计数，**只减不增**；`--init` 记首个基线，`--prune` 写回下降后的计数 | `verify-no-unknown-casts.ts`（AST 指纹改为正则计数，语言无关） |
| `run-gates.ts` | 读 `.agents/gates.json`，逐条跑完、汇总、任一失败即红；`--only <name>` 单跑 | `run-gates.ts`（去并发调度与分组） |

```sh
npx tsx .agents/skills/dsh-gate-every-rule/scripts/run-gates.ts            # CI 用这个
npx tsx .agents/skills/dsh-gate-every-rule/scripts/run-gates.ts --list
npx tsx .agents/skills/dsh-gate-every-rule/scripts/verify-md-links.ts [dir...]
npx tsx .agents/skills/dsh-gate-every-rule/scripts/verify-escape-hatch-baseline.ts [--init|--prune]
```

## 只减不增基线

逃生口每处单看都"有理由"，累计起来类型系统形同虚设；一刀禁又清不掉存量。DSH 的做法：记录当前数量作基线，门禁只允许持平或下降。

- 首次：复制 `templates/escape-hatches.json` 到 `.agents/escape-hatches.json`，按宿主语言删改 `patterns` / `extensions`，跑 `--init`。
- 新增一处 → 红；同一次改动里删掉别处一处则持平通过。
- 删掉一处后门禁会要求 `--prune`，把上限写低——棘轮只向下。
- 基线按文件 × 模式计数，不按行号，所以移动代码不触发。

## 本地 hook 窄、CI 宽

`templates/lefthook.yml` 搬自 DSH：pre-commit 只做秒级的事（归档封印、字数上限、staged lint 自动修、`git diff --cached --check`），pre-push 只跑增量 typecheck；测试按改动面选（[dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md)），全量矩阵交给 CI。

```sh
cp .agents/skills/dsh-gate-every-rule/templates/lefthook.yml ./lefthook.yml
npm i -D lefthook && npx lefthook install   # 并把 "postinstall": "lefthook install" 写进 package.json
```

hook 太重大家就 `--no-verify`，太轻等于没有；加一项前先量它的耗时。

## 加一条新规则的流程

1. 写门：`scripts/verify-<rule>.ts`，按上面的形态。
2. 造反例：一个最小的坏文件或坏片段，确认门对它非零退出；把这个反例留成测试（或至少写进 PR 说明"用 X 验证过门会红"）。
3. 挂进 `.agents/gates.json`，必要时加进 `lefthook.yml` 的对应阶段。
4. 这时才去 `AGENTS.md` 写那一行规则，并链接到门或细则（[dsh-layer-instructions](../dsh-layer-instructions/SKILL.md)）。
5. 门本身的改动是 `process` 类决策，值得一篇 Agent Note 时按 [write-notes-like-deepseek](../write-notes-like-deepseek/SKILL.md) 写。

## 接入 CI

把 `run-gates.ts` 作为唯一入口；GitHub Actions 示例：

```yaml
- run: npx tsx .agents/skills/dsh-gate-every-rule/scripts/run-gates.ts
```

归档封印那条门需要 `AGENT_NOTE_ARCHIVE_BASE_REF` 指向变更前 commit，见 [write-notes-like-deepseek 的 verify-notes.yml 模板](../write-notes-like-deepseek/templates/verify-notes.yml)。
