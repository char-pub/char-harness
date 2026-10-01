---
kind: upgrade-guide
description: Roleplay Selector 目录提供额外的可见元数据，可能改变请求预算和已记录 Plan 的验证结果。
---

# Roleplay Selector 目录元数据

[English](guide.md) | 中文

## 变更

打包的 char.pub SDK 在候选目录中提供作者声明的 perspective、keyword/semantic 激活提示和已解析的可见 `about` 身份。旧目录省略这些字段。只有实际展开到该节点时，Jev 才收到新增元数据。隐藏目标身份和候选正文仍不提供，关联也不会选中或激活目标。

目录预算与完整请求预算均计入这些字段。原先能放下的请求可能超过限额；Catalog、Plan、决策证据或作者诊断的比较结果可能变化。依赖旧投影的记录可能验证失败。保留的历史样本仍能验证，不代表所有记录都兼容。本次不改变 Session 事件结构或存储代。

## 迁移

1. 保留 Replay JSON、Session JSONL 与 SDK 快照清单的原始字节，升级前备份；保留的 SDK 快照见[供应方目录](../../../../third_party/charpub/README.zh.md)。
2. 重新检查实际请求限额并审阅 Selector 目录。只有经过明确配置决定才提高限额，不得通过移除新增元数据或跳过预算校验让旧请求勉强通过。
3. 在副本上验证已存练习和 Session。验证失败时，保留原记录及匹配 SDK 供隔离检查；不要重算旧 head、重写旧 Plan 或重新标记以前的提供方证据。使用新行为继续游玩时，应明确创建新 Session。
4. 更新模型可见请求快照前先审阅差异。运行 `pnpm run test:roleplay` 与 `pnpm run test:roleplay-runtime`，确认历史夹具摘要及 pending 恢复行为不变。这些本地测试不评估在线模型的选材质量。
