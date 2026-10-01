---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-01-charpub-client-origin

[English](2026-10-01-charpub-client-origin.md) | 中文

## 概述

在 roleplay/opened 保存的固定 char.pub 产物中，为贡献者记录保留可选的外部客户端 ID。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-01-charpub-client-origin
baseline: false
changes:
  - root: "event:roleplay/opened"
    previous: "2026-09-30-charpub-roleplay-events"
    after: "c5069d032188c2d638fae7b35f54d85d6645aa3d63a73890425cb499bbccca81"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

可选 client_id 字段扩展了嵌入产物的元数据及 IR 元数据，不改变 Session 帧格式、已有必填字段、requested 事件或 settled 事件。没有客户端 ID 的已有记录仍然有效。前一 roleplay 声明和已定稿 Session 存储代保持不变。

<a id="verification"></a>
## 验证

已安装 SDK 通过两组保留历史样本的不可变回放和真实 JSONL 恢复，包括 pending 中断且不派发模型请求。独立包消费测试构建带客户端署名的产物，并检查产物元数据与 IR 元数据均保留 client_id。Source fixture 回放保留精确 BOM、CRLF、分解形式 Unicode 和尾部空白。

<a id="dev-note"></a>
## 开发备注

无。
