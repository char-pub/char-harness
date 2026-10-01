---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-charpub-roleplay-events

[English](2026-09-30-charpub-roleplay-events.md) | 中文

## 概述

为独立 char.pub 驱动器新增必需读取的 roleplay opened、requested 和 settled 会话事件；固定 SDK 输入保留 Release、draft-build 或 local-build 身份。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-charpub-roleplay-events
baseline: false
changes:
  - root: "event:roleplay/opened"
    previous: null
    after: "c5ad4768406d57113cb822813dc4192171c95e7bec94588b2d3d1a664a90a535"
    decision: same-version
  - root: "event:roleplay/requested"
    previous: null
    after: "9323ce58defdcb51a7e6e54e647763c7cc3ab7c8cef41d783dda9491fabcf416"
    decision: same-version
  - root: "event:roleplay/settled"
    previous: null
    after: "3aaa77ff2f8c9328943a9090210c47a82accab8cfd2c8559fcb33bf602ccf8a2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有会话记录保持有效。不认识新事件名的读取器拒绝角色剧情日志，事件不标记 ignorable。opened 固定 SDK 输入，requested 记录未提交命令和精确模型输入，只有成功 settled 提交完整剧情状态和助手历史。尚未接受的实验声明包含当前 SDK 产物联合类型。不替换已接受的持久化记录或已提交 Session 代。固定旧 SDK Replay 与真实 JSONL 样本可由新 SDK 恢复；该样本不证明全部历史产物兼容。prepared-history 合成元数据不声称保留原助手模型身份。

<a id="verification"></a>
## 验证

pnpm run test:roleplay-runtime：21 项通过，包含真实 Loader profile、JSONL 关闭恢复、固定旧 SDK 历史、未完成请求中断且不重发、消息一致、取消、存储失败核对和命令/配置幂等。旧样本摘要保持不变。没有真实模型调用或默认 Web/SDK 接入证据。

<a id="dev-note"></a>
## 开发备注

无。
