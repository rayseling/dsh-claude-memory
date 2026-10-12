# AGENTS.md

<一句话说明这个仓库是什么；需要先读的文档用链接：读 [docs/architecture.md](docs/architecture.md) 再改 `src/`。>

## 仓库布局

```
src/        <一行说明>
tests/      <一行说明>
docs/       文档（规范见 docs/AGENTS.md）
.agents/    Agent Notes（.agents/notes/AGENTS.md）与 skills
scripts/    门禁与生成器
```

## 命令

```sh
npm install
npm test                 # 单元测试
npm run verify-notes     # Agent Notes 三条校验
npm run gates            # 全部 verify-* 门禁（CI 用这个）
```

## 约定

<每条规则一行：先给可执行的结论，再用链接指向理由或细则。规则与门禁一一对应：没有门禁撑腰的规则写在这里等于没有。>

- **非平凡改动必须留 Agent Note**：按 [.agents/skills/write-notes-like-deepseek/SKILL.md](.agents/skills/write-notes-like-deepseek/SKILL.md)；机械性小改直接提交。
- **破坏外部可见表面必须同批写升级指南**：按 [.agents/skills/dsh-create-upgrade-guide/SKILL.md](.agents/skills/dsh-create-upgrade-guide/SKILL.md)。
- **推送前只跑覆盖本次改动的检查**：按 [.agents/skills/dsh-pre-push-checks/SKILL.md](.agents/skills/dsh-pre-push-checks/SKILL.md)；CI 拥有全量矩阵。
- **错误处理**：类型化失败、明确处理归属与遏制范围、不确定状态必须可见；按 [.agents/skills/dsh-error-handling/SKILL.md](.agents/skills/dsh-error-handling/SKILL.md)。
- **注释与文档写契约，不写推导过程**：按 [.agents/skills/dsh-prose-standard/SKILL.md](.agents/skills/dsh-prose-standard/SKILL.md)；发现会话痕迹用 [.agents/skills/dsh-trim-cot-leakage/SKILL.md](.agents/skills/dsh-trim-cot-leakage/SKILL.md)。
- **类型逃生口只减不增**：`npm run gates` 里的 `verify-escape-hatch-baseline` 守基线；新增一处必须同批删一处。
- **每条新规则同批交一道门禁和一个它能拒掉的反例**：按 [.agents/skills/dsh-gate-every-rule/SKILL.md](.agents/skills/dsh-gate-every-rule/SKILL.md)。
- 文件以且仅以一个换行结尾；`git diff --cached --check` 在 pre-commit 把关。

## 编辑本文件

`CLAUDE.md` 是指向本文件的符号链接（`ln -s AGENTS.md CLAUDE.md`），改这里。每条规则自含一句话并链接细则；`verify-doc-budgets` 守字数上限，要加内容先删或下沉到链接目标。
