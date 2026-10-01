---
kind: upgrade-guide
description: Roleplay 回放和 Session 校验现在会拒绝旧规范化摘要可能遗漏的运行时原文变化。
---

# Roleplay 记录的精确摘要

[English](guide.md) | 中文

## 变更

实验性 char.pub 回放和 roleplay runtime 现在精确绑定命令、轮次、已准备消息、决策凭据和 Session 投影中的 JSON 字符串及字典键。Unicode 规范化、换行和尾部空格均影响身份。Source 资产继续按现有规则校验原始字节；作者内容规范化不变。

使用规范化文本的旧记录仍可兼容。包含非规范化运行时文本的记录，即使没有被修改，也可能因存储摘要采用旧规范化算法而无法通过新校验。校验不会回退旧算法，也不会改写已记录的 head。事件结构和 Session 存储代未变。

## 迁移

1. 升级前备份已有 roleplay Replay JSON 和 Session JSONL，保留原始字节及其已记录清单对应的 SDK 快照；保留规则见 [SDK 供应目录](../../../../third_party/charpub/README.zh.md)。
2. 使用现有消费者对副本执行回放或 Session 检查。校验成功可正常使用；精确摘要不匹配时需审阅，不能修改日志或重新计算摘要来绕过校验。
3. 如需按旧行为审阅，在隔离环境使用对应旧 checkout 和 SDK 快照，不调用模型、不继续写旧日志。使用新 runtime 继续时明确创建新 Session，不将其描述为旧状态的自动迁移。
4. 确认原文件字节未变。runtime 测试覆盖三个保留的历史 Session 样本，并明确验证旧原文 Replay 被拒绝且不会被重写。
