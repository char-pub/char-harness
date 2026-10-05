---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-roleplay-ending-guidance-version

[English](2026-10-05-roleplay-ending-guidance-version.md) | 中文

## 概述

为记录的结局提案增加可选 guidance_version: 2，让新叙述区分结构化确认与普通玩家文本中的同意。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-roleplay-ending-guidance-version
baseline: false
changes:
  - root: "event:roleplay/turn-requested"
    previous: "2026-10-05-roleplay-player-turns"
    after: "4423cf724108d910961087ac89fd1b2005e09a1511750bd2158fcf145e135b96"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

可选字段仅位于新增回合操作及 director binding 内。guidance_version 缺省时选择原指令字节，不添加默认值，也不改变旧提案 ID、准备消息、请求摘要或历史结局语义。新提案显式选择版本 2。旧 requested 和 settled Schema 及 Session 写入版本保持不变。

<a id="verification"></a>
## 验证

改动前采集的无需密钥 JSONL 样本保留无版本提案、确认及撤回。测试固定其 manifest 与字节，通过真实 Loader 服务读取临时副本，不写入也不派发模型，并比较待确认提案、准备消息、请求摘要、逻辑 head 和持久 revision。包含 confirm/adopt/agree 的新普通玩家文本仍保持待确认，并在实际记录的叙述消息中收到带版本指令；运行时与 app 快照覆盖该指导。

<a id="dev-note"></a>
## 开发备注

无。
