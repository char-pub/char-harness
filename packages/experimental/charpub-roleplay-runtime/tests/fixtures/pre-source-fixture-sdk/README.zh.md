---
description: "在 Source fixture 与客户端来源 SDK 更新前捕获的不可变回放和 JSONL 证据。"
---

# 前一 SDK 恢复样本

[English](README.md) | 中文

## Summary

本样本保留前一安装版本 SDK 生成的 Replay 和真实 Session JSONL 字节。manifest 固定包字节、已记录消息和文件摘要。测试不会重建其中的产物或覆盖已记录的 Session。

## Table of Contents

- [捕获](#capture)
- [恢复](#recovery)
- [Dev Note](#dev-note)

<a id="capture"></a>
## 捕获

保留的 [SDK manifest](../../../../../../third_party/charpub/snapshots/story-v1-bb93d2171b49cf91/manifest.json) 标识已安装输入。修改依赖前，[捕获工具](../capture-history.ts) 中的 `captureSnapshotHistory` 验证 manifest 摘要和两个已安装包的定位路径，再独占创建本目录。真实 Loader、JSONL 提供方和 runtime 在无网络调用的情况下，记录了两次合成文本回复和一条已 flush 但未回复的请求。[样本 manifest](manifest.json) 记录精确字节；复制更早的历史样本不能替代本次捕获。

捕获要求指定快照已经安装。安装其他快照时，工具会在创建目标目录前失败。每次捕获使用新目录。[更早的样本](../legacy-sdk-280c696c/README.zh.md) 保持为独立证据。

<a id="recovery"></a>
## 恢复

[历史测试](../../history.test.ts) 验证不可变 manifest 和文件摘要，重建已提交的状态和消息，并通过真实 Loader 读取 JSONL。pending 恢复在临时副本上执行，记录中断且不派发模型调用。只读恢复不重写副本中已提交的存储代；原始文件全程保持不变。本样本通过不代表所有历史产物均兼容。

```sh
node --import tsx/esm --test packages/experimental/charpub-roleplay-runtime/tests/history.test.ts
```

<a id="dev-note"></a>
## Dev Note

无。
