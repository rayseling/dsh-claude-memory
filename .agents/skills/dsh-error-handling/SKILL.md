---
name: dsh-error-handling
description: Apply error-handling principles when designing or reviewing failures, recovery, retries, background tasks, fallbacks, empty catch blocks, and user-visible error reports. Use whenever code catches, swallows, retries, or reports an error, or when a review must decide whether a failure path is safe.
---

# 错误处理（Error Handling）

> 搬自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh-error-handling` skill 与其 `AGENTS.md` 的两条规则（"typed, structured failures" / "an empty catch names the error"）。它是评审清单，不是脚本。

定义每个失败是什么、谁负责、失败之后什么仍然安全。

## 类型化、结构化的失败

- 预期中的失败要有声明的类型、稳定的判别字段、处理所需的细节。复用模块已有的错误约定，保留 cause，把机器身份和展示文本分开。
- **永远不靠解析错误消息来分支。**
- 意料之外的缺陷（`assertNever`、不变量被破坏）可以是普通 `Error`；遏制它绝不能把它变成成功。

## 捕获、恢复，或停下

对每个失败，在拥有它的 API 文档里写清：**处理归属、报告归属、遏制范围、失败保证**——哪些不变量仍然成立，副作用是未发生 / 部分发生 / 已提交 / 未知，谁负责清理。后台任务同样承担这些义务。

- 捕获只限制异常的传播，不撤销已经发生的变更。只有受影响状态的所有者才能判定能否安全继续；否则**停止依赖它的工作，丢弃无效状态或实例，或向上升级**。
- **只打日志不算恢复。**
- 重试要满足：重复执行安全、可取消、有明确所有者。有限操作要有预算（次数 / 时间）；持续的监督要有生命周期所有者和可观察的退化。
- 隐式 fallback（`?? default`、静默回退到旧路径）是把故障藏起来：默认值应是显式的解析步骤，缺失的引用要响亮失败。

## 本地化、可执行、看得见的报告

- 每份最终报告包含：可读的摘要、受影响的操作、安全的下一步。
- 有本地化机制的应用走它的机制；其他诊断沿用各自已有的输出语言。
- 敏感的内部细节不进用户可见文本。
- **不可信状态或未知结果必须可见**：通过 UI 或默认开启、可访问的日志，报告影响、不确定性、系统处置和安全的下一步。持久的无效状态需要持久的可见性。
- 没有保证就不要声称成功、已回滚、可安全重试。报告路径本身的失败需要独立的兜底。

## 空 catch

```ts
try {
  unlinkSync(lock)
} catch {
  // ENOENT: another worker already released the lock; nothing left to clean.
}
```

空 `catch` 必须**点名被吞的错误和为什么可以吞**；它的 `try` 只包一条语句，免得顺便吞掉别的。

## 验证什么

验证**结果状态和可见输出**，不是"异常被捕获了"。测试要断言：失败后哪些状态仍有效、用户看到了什么、后续操作是否被正确拒绝。

## 出处

Meyer《Object-Oriented Software Construction》(1997)：契约与不变量；Sutter《Exceptional C++》(1999)：异常安全保证；Armstrong [博士论文](https://www.erlang.org/download/armstrong_thesis_2003.pdf) (2003)：隔离与监督。
