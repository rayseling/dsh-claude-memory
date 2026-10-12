# Agent Note: 子代理默认不注入

Status: implemented

## Problem

dsh 的子代理也经过 `agent/pre-step`。要决定记忆索引是否也塞给它们。

## Decision

默认只注入主代理。`includeSubagents` 配置项留作开关。

## Alternatives considered

- **对子代理一并注入。** 实现上零成本(同一个监听器)。Claude Code 不给子代理记忆(fork 除外);与之保持一致,并避免每个子代理都多占一份索引的上下文。

## Consequences

- 收益:行为与 Claude Code 一致,子代理上下文不被索引占用。
- 代价:需要记忆的子代理场景要显式打开 `includeSubagents`。
