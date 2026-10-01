# DOR

- 起点：DeepSeek Harness 的 TypeScript/Cordis/pnpm monorepo；上游许可、notice、vendor来源保留。
- char.pub Story 契约正在独立仓库实现，发布包/pack tarball作为共享入口，不复制 schema 和求值器。
- 必须读 packages/AGENTS.md、docs/architecture.md后实现插件。消息从 Session 日志投影，Prepared Context 必须选择唯一渲染权威；不得重复注入 history/system。
- Laya已找到匹配官方候选NandhaKishorM/laya / convaiinnovations/laya；以该上游为可替换假设继续适配，尚无推理质量证据。HTTP/router/confidence语义已按固定源码接入独立Laya适配，保留独立provider和实际routing；不能只换Jev的baseURL而沿用Jev身份。
- 依赖安装、固定SDK消费、真实命名profile与JSONL恢复、编译导出及相关测试已验证（见PROGRESS，本轮终态127项）。唯一日志投影与真实composition已接通；在线模型质量尚未验证。完整游戏客户端与默认Web/SDK分发属于后续Runtime路线，不是当前最小消费入口的完成条件。
