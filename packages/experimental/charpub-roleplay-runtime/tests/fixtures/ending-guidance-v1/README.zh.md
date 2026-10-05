---
description: "在叙述指导版本化之前记录的结局提案 JSONL 固定证据。"
---

# 无版本结局指导

[English](README.md) | 中文

这个样本在增加可选指导版本前采集。真实 Loader 与 JSONL 运行时通过无需密钥的测试提供方记录一次结局提案、显式确认和撤回。因此，待确认提案与两次叙述请求保留原指令字节；不包含私有游玩日志或在线模型输出。

[manifest](manifest.json) 固定 Session 字节、逻辑 head、持久 revision、待确认提案、请求摘要和准备消息。[结局测试](../../ending-confirmation.test.ts) 固定该 manifest，在不派发的情况下检查临时 JSONL 副本，比较每条保留请求并回放旧逻辑日志。检查和测试都不改写样本。保持这些字节冻结；新的指导版本应独立采集。
