---
name: dsh-create-upgrade-guide
description: Use when a change breaks something a user outside the repository can observe after upgrading — CLI commands or flags, config keys or accepted values, persisted data or file formats, public SDK/HTTP/RPC messages, published package names or entry points — or when touching a surface an unreleased guide already covers. Writes docs/upgrade-guide/v<version>/<item>/guide.md in the same change.
---

# 破坏性改动即时记账（Create Upgrade Guide）

> 搬自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh-create-upgrade-guide` skill、`dsh-doc/templates/upgrade-guide.md` 与 `scripts/verify-upgrade-guides.ts`。去掉了双语配对与 Session 格式专属规则。

升级指南告诉运行着版本 vT 的读者，为了跑下一个版本要改什么。**在引入破坏的那次改动里就写**，一发现是破坏就写，不留到发版前再回忆。

## 写的范围

只为仓库外的人升级后能观察到的破坏写：

- 命令、参数、配置文件的键或其可接受的值；
- 落盘数据：日志、数据库、用户数据目录、文件格式；
- 公共 SDK 导出、HTTP / RPC / 消息格式；
- 发布的包名与入口。

内部 API 的消费者都在同一次改动里更新的，不用写。持久化格式的改动另有其规则（版本后继、永不覆盖旧代），指南只写读者要做的动作并链接那条规则。

## 位置

`docs/upgrade-guide/v<version>/<item>/guide.md`

- `<version>` 是写指南时根 `package.json`（或宿主的版本源）的 `version`，例如 `v0.1.7-rc.2`；指南描述从该版本升到下一个版本。
- `<item>` 是被改表面的 kebab-case 名，例如 `profile-flag-rename`。
- 每个 item 目录只放 `guide.md`：没有索引，没有附件。

## 维护

版本号没变期间，当前版本目录描述从 vT 到当前主干的差异：后续改动碰到已有指南覆盖的表面，就在同一次改动里更新那篇；破坏被回滚就删掉指南。版本号一升，旧目录冻结，新破坏进新目录。**一篇指南永远不跨多个版本。**

## 格式（`verify-upgrade-guides` 强制）

从 `templates/upgrade-guide.md` 起草：

- frontmatter 恰好两个键：`kind: upgrade-guide` 和一句话 `description`，点名什么坏了；
- 一个 `#` 标题，然后恰好 `## 变更`、`## 迁移` 两节（也接受 `## Change` / `## Migration`），顺序固定；
- 含 frontmatter 不超过 500 词（中文按字计）。

`变更` 写该表面的旧行为、新行为、谁受影响。`迁移` 写有序步骤，点名精确的文件、键、命令或符号，并说明怎么确认迁移成功。

超过 500 词时多出来的内容另有去处：链接源码或符号而不是复述；理由进 Agent Note；重复的机械步骤做成脚本让指南去调用。文风按 [dsh-prose-standard](../dsh-prose-standard/SKILL.md)。

## 校验

```sh
npx tsx .agents/skills/dsh-create-upgrade-guide/scripts/verify-upgrade-guides.ts
npx tsx .agents/skills/dsh-gate-every-rule/scripts/verify-md-links.ts docs/upgrade-guide
```

把第一条接进 `.agents/gates.json`（[dsh-gate-every-rule](../dsh-gate-every-rule/SKILL.md)）。

## 内部 / 合作项目

指南就是发给合作方的"变更通告"：合入前必须存在，发版说明从这些文件生成，不靠回忆。没有 GitHub release 的项目尤其需要它。
