---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-05-roleplay-player-turns

[English](2026-10-05-roleplay-player-turns.md) | 中文

## 概述

新增保存玩家意图、有界决策请求与结果、原子回合叙述、回合中止及仅追加撤回的必需事件。新回合可选保存绑定状态的结局提案与显式确认；固定产物输入增加可选的作者声明玩家控制。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-roleplay-player-turns
baseline: false
changes:
  - root: "event:roleplay/decision-requested"
    previous: null
    after: "6cae4ac270e7a3a906ea491be85cbc7ed65769ab4e19ba4b412635d1e0eca343"
    decision: same-version
  - root: "event:roleplay/decision-settled"
    previous: null
    after: "d16eee9f50096c74d9069b1ea1bbdc7702f966ce0ee22a01570d6053943893cf"
    decision: same-version
  - root: "event:roleplay/opened"
    previous: "2026-10-01-charpub-client-origin"
    after: "e224e23fc6488b4ec422884c3a1f6bd1ae9aee4f7e9a8ec0fd47b050ce7485b6"
    decision: same-version
  - root: "event:roleplay/rewound"
    previous: null
    after: "1ff8ac69735da91a644ea71fd33e39bfca274783bb71184a757e9863e314e588"
    decision: same-version
  - root: "event:roleplay/turn-aborted"
    previous: null
    after: "46e5038549e044a20354a7810275826471232daef93713194b159ce98b665c61"
    decision: same-version
  - root: "event:roleplay/turn-requested"
    previous: null
    after: "984d4f9a67c1ab8251e8c1605b4c32b2114d97059f1c49950e0d98df06f25fee"
    decision: same-version
  - root: "event:roleplay/turn-started"
    previous: null
    after: "92438df3901fe691f0cc84c57f3d0c65846d8defc2138310981f75529976031b"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有 requested 和 settled Schema 保留原命令与精确摘要。原子回合命令使用独立必需事件 roleplay/turn-requested，旧读取器会拒绝不认识的事件。新增回合操作与 director binding 上的结局提案/确认字段为可选，新增玩家意图上的 confirm_ending 也为可选。缺少元数据时不添加默认值，保留已记录的自动结局语义。固定内容上的 Story.player 为可选字段，旧产物及消息保持原行为。Session 写入版本和既有 JSONL 文件不变。撤回恢复 Story 逻辑状态及此前待确认提案，同时保留事件和已使用的请求 ID；revision 覆盖全部事件，包括失败尝试与撤回。

<a id="verification"></a>
## 验证

归属 Replay、提供方、组合、投影、profile 及不可变历史测试覆盖持久回合、全部五个写入屏障、陈旧 revision、显式恢复、作者选项可用性、本次输入归属与历史 SDK 字节。结局测试覆盖确认前无效果、hidden/on-reach 信息披露、重启、确认失败及中断、重复恢复、普通回合失效、撤回与历史自动结局回放。官方 DeepSeek 适配器 HTTP fixture 检查实际 profile 插值、独立模型路由、低强度决策思考与关闭叙述思考。包 TypeScript 构建、严格 NodeNext 测试检查和持久化新鲜度检查验证结果类型。测试使用本地模型/HTTP fixture，不证明在线模型质量。

<a id="dev-note"></a>
## 开发备注

无。
