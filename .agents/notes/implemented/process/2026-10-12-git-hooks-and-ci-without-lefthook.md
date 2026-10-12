# Agent Note: 本地 hook 用 .githooks,CI 只跑门禁

Status: implemented

## Problem

门禁只能手动跑,忘了就带着红门提交。dsh skill 的标准做法是 lefthook + `npm i -D`,但这个仓库的 `node_modules` 是指向 `~/.dsh/profiles/node_modules` 的软链:任何 `npm i -D` 都会写进 dsh profile 的共享目录。测试依赖的三个 peer 包只有 profile 里的 alpha 版本能跑,npm 上的 `0.0.1-rc.1` 接口不同,CI 装不到能用的版本。

## Decision

- 本地 hook 是仓库里的 `.githooks/pre-commit` 与 `.githooks/pre-push`,每个 clone 执行一次 `git config core.hooksPath .githooks` 启用。pre-commit 只做秒级的事:动了归档区才跑封印校验,动了预算文件才跑字数门禁,外加 `git diff --cached --check`。pre-push 跑 `run-gates.ts` 全部门禁和 `node --test`,两者合计约一秒。
- CI 是 `.github/workflows/gates.yml`,只跑 `run-gates.ts`,不跑测试;`AGENT_NOTE_ARCHIVE_BASE_REF` 取 PR base 或推送前的分支 tip。测试只在本地由 pre-push 跑。
- 所有 `.ts` 脚本用 `node` 直跑,不走 `npx tsx`。

## Alternatives considered

- **lefthook(skill 模板)** — 有 glob 过滤和 `stage_fixed`,是 DSH 主仓库的做法。被否:安装它要 `npm i -D`,会污染 dsh profile 的共享 `node_modules`;本仓库没有 lint 和 typecheck,lefthook 的增量能力没有用武之地,两个 shell 脚本已够。
- **CI 里 `npm install` 三个 peer 包后跑测试** — 让 CI 覆盖测试。被否:npm 上的版本是 `0.0.1-rc.1`,profile 用的是 `0.2.1-alpha.2`,接口不一致,测试会因版本而非代码失败。peer 包发到 npm 的版本追上 profile 后重访。
- **把 `core.hooksPath` 写进 `package.json` 的 `postinstall`** — 自动启用。被否:仓库没有依赖,没人会跑 `npm install`,写了也不触发。

## Consequences

- 收益:提交和推送前自动跑门禁,CI 对 PR 和 main 再跑一次;本地无需安装任何包。
- 代价:`core.hooksPath` 要每个 clone 手动设一次,忘了就退回手动跑门禁;测试没有 CI 覆盖,只靠 pre-push。
- 门禁清单在 `.agents/gates.json`,新门加进去后本地 hook 和 CI 自动跟上。

## Verification

`git config core.hooksPath` 输出 `.githooks`;`git push` 前终端出现 `run-gates: 7 gate(s) passed` 和 `node --test` 的 pass 计数。GitHub 仓库的 Actions 页上 `Gates` workflow 绿。
