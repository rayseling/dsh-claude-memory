---
name: dsh-pre-push-checks
description: Use before pushing, force-pushing, opening or un-drafting a PR/MR, or claiming that checks pass, to select the smallest set of tests and gates that cover the outgoing diff instead of reflexively running the whole suite or running nothing. Also use to report evidence honestly (commands actually run, failures verbatim).
---

# 推送前按改动面选证据（Pre-Push Checks）

> 搬自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh-pre-push-checks` skill 与 `scripts/change-scope.ts`。去掉了 DSH 特有的 Vitest 覆盖率、快照目录与 GitHub 栈 PR 流程；证据类别留给宿主在 `AGENTS.md` 填。

## 两个极端都是错的

- **什么都不跑就说"done"**：agent 最常见的失败。没有证据的"应该没问题"不是汇报。
- **反射式跑全套**：十分钟的全量测试让每次 commit 都变贵，最后大家 `--no-verify`。

DSH 的原则：**没有通用的本地基线。** 每个行为改动需要的是"会因这个回归而失败的最窄检查"；更宽的检查只在 diff 真的碰到那个面时才加。全量矩阵归 CI。

## 第一步：列出改动面

```sh
git status --short --branch
npx tsx .agents/skills/dsh-pre-push-checks/scripts/change-scope.ts --base <已核实的 PR 基线或栈父分支>
```

`change-scope` 输出版本化 JSON：`committed`（相对合并基点）、`staged`、`unstaged`、`untracked` 四组路径。它**不猜基线、不 fetch**；基线从远端或 PR 状态核实后传入。合并了新基线之后重跑，只补跑被合并失效的检查。

## 第二步：按面查表选证据

宿主在 `AGENTS.md` 维护一张"改动面 → 最小证据"表；没有的话用下面这张通用表起步：

| 改动碰到的面 | 最小证据 |
|---|---|
| 某模块的逻辑 | 该模块自己的测试文件或聚焦的测试名；共享契约变了再加相邻模块的测试 |
| 文档、Agent Notes、带链接的注释 | `run-gates` 里的文档门（md-links、doc-budgets、note 三条） |
| 用户/模型可见的输出（CLI 文案、提示词、渲染结果） | 拥有该输出的快照或录制用例；没有就说明"无 owning 用例，未改" |
| 包清单、公共导出、构建配置、入口 | build + 对应的产物冒烟 |
| 真实外部服务（provider、API） | 有凭据时跑对应 e2e；永远不打印密钥 |
| 落盘/网络/配置格式 | 迁移或兼容测试 + 升级指南（[dsh-create-upgrade-guide](../dsh-create-upgrade-guide/SKILL.md)） |

规则：

- **不重复已通过的检查**。pre-push hook 已跑 typecheck，就不要在推送前再手动跑一次。
- **过滤后的测试要看选中数量**。`-t <name>` 选中 0 个用例的"通过"不是证据。
- **跨仓库的改动才跑全量**，或用户明确要求、或在诊断 CI 失败时。

## 第三步：处理失败

- 相关检查红了：**停下来修或说明阻塞**，不要推上去赌 CI 不一样。
- 看起来是环境特定的失败：记录精确命令、失败用例、平台差异；确认非平台相关的证据通过；优先修跨平台不确定性。
- 只有用户明确同意才绕过本地 hook，并如实报告绕过了什么、为什么预期 CI 不同。

## 第四步：推送与核对

1. 跑选中的检查一次。
2. 正常提交；pre-commit 自动修改过的文件先过目。
3. 推送；历史重写只用 `--force-with-lease=<branch>:<观测到的远端 OID>`，远端动了就中止，**永远不用裸 `--force`**。
4. 核对远端等于本地：`git rev-parse HEAD origin/$(git branch --show-current)`。
5. 有 CI 就看 CI（`gh pr checks` / GitLab pipeline）；pending 报 pending，失败先看原因再归因。

## 汇报形态

只报**实际跑过的命令**和它们的结果；跳过的说跳过；失败的贴原始输出。

```markdown
已跑：
- npx vitest run src/auth/jwt.spec.ts（12 passed）
- npx tsx .agents/skills/dsh-gate-every-rule/scripts/run-gates.ts（7/7 ok）
未跑：e2e（无凭据）；全量测试（改动限于 src/auth/，CI 覆盖）
```
