---
name: dsh-agent-experience
description: Use when writing or changing anything a model reads as instructions — a tool definition (name, description, parameter schema, its system-prompt section), an MCP tool, a skill's SKILL.md or description, injected context, or a multi-step workflow — to make information discoverable and use context efficiently.
---

# 模型可见文本怎么写（Agent Experience）

> 搬自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `agent-experience` skill，内容无宿主专属项，逐条对译。对象是**模型读到的文本**，不是给人看的文档。

## 上下文怎么喂

- **从最小上下文开始**：先暴露目的、可用动作、约束；细节指令在需要时再加载。
- **发现要显式**：每个延迟加载的资源都要有清楚的描述和可靠的取回方式（skill 的 `description` + `references/` 就是这个模式）。
- **关键约束放在动作之前**：权限、破坏性副作用、必需的校验，出现在对应动作的前面，不放末尾。
- **输出有界**：返回简洁结果加可取回细节的 id 或路径；不倾倒整份日志或文档。
- **利用局部性**：操作结果附带有限的、很可能用到的相邻上下文（例如一条回复带前几条消息）。省略和截断要明确标出，并给出取回更多的方式。
- **算总账**：省上下文只有在不引发更多搜索、重复读取或错误时才算省。

## 工具定义

- **删掉显然的约束**：模型从调用结果就能学到的规则不写——读不存在的文件会失败、发送失败就是没送达。
- **写行为不写实现**：说工具做什么、返回什么；不说内部机制、模型在结果里看得到的标记、怎么强制执行。
- **参数规则写在参数上**：默认值、范围、配对关系、何时该设，放进该参数的 description 或 schema；一段随配置变化的描述，变化的部分通常就是一个参数。
- **每个事实只说一次**：不在系统提示段重复工具定义，不在工具描述里重复参数描述，不在一个工具里写另一个工具的规则。
- **量化改动**：改工具定义前后对比首轮 prompt 的 token 数。
