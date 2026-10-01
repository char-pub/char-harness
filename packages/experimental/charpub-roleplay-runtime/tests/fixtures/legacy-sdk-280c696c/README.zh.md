---
description: "用于限定范围历史恢复检查的固定旧 SDK Replay 与 JSONL 字节。"
---

# 旧 SDK 读取兼容性 fixture

[English](README.md) | 中文

## 概述

这些固定文件保存一份旧 SDK Replay 和真实 JSONL Session，用于兼容性检查。恢复测试使用临时副本，永不重写记录的输入。成功恢复只覆盖此样例。

## 目录

- [保存的证据](#stored-evidence)
- [捕获方法](#capture-method)
- [验证](#verification)
- [开发备注](#dev-note)

-----

<a id="stored-evidence"></a>
## 保存的证据

这些字节在替换最初打包的 char.pub SDK 前捕获。`manifest.json` 包含精确的旧包哈希、文件哈希和预期已提交消息。源码版本与 dirty 构建标记记录在 manifest（元数据清单）中，仅凭提交版本无法重现这些字节。该目录是不可变测试证据，不是活动 Session 根目录。不得通过修改哈希让新 SDK 测试通过。

捕获使用真实 Cordis Loader、roleplay runtime 和 JSONL 提供方，以及现有不联网的测试 LLM（大语言模型）适配器。Alice 确认一次奖励并选择向导 Source；Bob 进入花园，排除 Alice 的私有事实。两次响应都成功结算。第三个请求通过真实持久化句柄追加并刷盘，但没有结算。`replay.json` 保存该待处理请求之前的已提交回放；`session.v4.jsonl` 保存真实头部和六个持久事件，保留原时间戳与字节顺序。

历史测试在回放前校验文件摘要，读取 JSONL 临时副本且不重写，随后只在副本中将待处理请求恢复为 interrupted，模型派发次数为零。测试永不以写模式打开仓库中的 Session 树。这只是一份有代表性的旧输入，不代表所有旧产物兼容。新 SDK 可以明确拒绝不支持的历史；应保留证据并说明边界，不能重建产物或修改记录的 Plan/head。

<a id="capture-method"></a>
## 捕获方法

一次性生成器在创建任何目标目录前要求最初安装的 tarball 定位符和精确的原 SDK manifest。它拒绝当前快照安装，也拒绝已有目标目录。在原 SDK 安装下，命令如下：

```sh
node --import tsx/esm --input-type=module -e 'import { captureHistory } from "./packages/experimental/charpub-roleplay-runtime/tests/fixtures/capture-history.ts"; await captureHistory("packages/experimental/charpub-roleplay-runtime/tests/fixtures/legacy-sdk-280c696c")'
```

不得对该目录再次运行命令。捕获其他 SDK 需要另行审阅的生成器、针对其已安装 SDK 的检查和新目标目录；这形成新证据，不替换现有证据。

<a id="verification"></a>
## 验证

```sh
node --import tsx/esm --test packages/experimental/charpub-roleplay-runtime/tests/history.test.ts
```

原安装已通过两个测试。新 SDK 测试必须单独报告兼容结果或明确拒绝；仅靠新建的动态 fixture（测试前置数据）不能证明旧日志兼容。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
