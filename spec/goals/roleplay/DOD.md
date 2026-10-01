# DOD

- [x] H0：独立本地 Git 仓库、工作分支、上游来源和许可保留（见 PROGRESS）。
- [x] H1：明确唯一的模型消息投影和日志事件，固定消费包版本，不直接跨repo import src。
- [x] H2：roleplay composition 使用固定决策完成本地消费路径，状态、Plan、模型输入可重放。
- [x] H3：Jev typed适配、取消/超时/未知/失败回退有验证；Laya身份核实后接入。离线协议测试与在线质量证据分开。
- [x] H4：相关typecheck/包测试/真实profile composition与keyless snapshot通过；文档与源码对应，无在线密钥时不宣称已完成在线验证。

H1/H2证据：`pnpm run test:roleplay-runtime`的18项测试（含真实命名profile和JSONL关闭恢复）、`pnpm run test:roleplay`的28项测试、固定tarball manifest、持久事件目录/确认检查通过。范围是独立基础driver/profile，不代表默认Web/SDK或完整游戏客户端完成。


H3/H4 终态证据（2026-10-01）：

- H3：Jev 官方 SDK 的原 14 项协议测试及原模型可见请求快照通过；Laya 固定上游 HTTP/router/confidence 语义对应的 9 项测试通过，含实际本地 HTTP、多级选材、三值/低置信度弃权、明确模型与实际路由、取消/响应正文超时和失败回执。上游是已核实项目/模型卡互链的具体候选；测试没有加载权重或访问在线推理，概率质量和校准仍未验证。
- H4：`test:roleplay` 为 40 项源码 + 2 项真实 compiled ESM + 1 项 SDK verifier；`test:roleplay-runtime` 为 84 项（含真实命名 profile/Loader、JSONL 与三代历史恢复），合计 127 项。包构建、无源码 alias 的独立 NodeNext tests 类型、定向 lint、constraints、持久化检查及当前文档门禁通过，完整命令与日志见 PROGRESS 本轮记录。
- Jev/Laya 的模型可见协议快照及历史 Session 回放均无需在线密钥。当前持久工件只因来源行号 23→24 重生，65 roots/10 records 的语义检查仍是空变化；没有修改历史确认或 Session 存储代。
- 这些勾选只验收 VISION 的独立基础消费入口，不新增完整游戏客户端、默认 Web/SDK 分发或自动模型开局回执义务。相关限制继续保留，不能将本地固定替身称作在线模型质量验收。

## 用户追加的交付

- [x] H5：获取最新upstream/master并rebase，保留备份分支与上游来源。2026-10-01实际fetch核对upstream/master，rebase结果up to date；本轮前backup分支保留原状态，具体引用以Git分支列表为准。
- [x] H6：完成面向游玩的UI设计与实现；主路径、首次进入/无作品/授权/模型配置缺失/加载/回复/取消/错误与恢复可实际操作，技术细节渐进暴露；通过当前真实浏览器及浅/深背景可读性验证，不以固定模型替身冒称在线质量。
- [ ] H7：char-pub/char-harness仓库创建并推送已验证代码；保留上游许可/历史，密钥与实际Session不上传；真实远端默认分支与本地交付SHA一致，远端检查按实际状态记录。
- [ ] H8：llmdoc按init建立有效V3语义路由与元数据；domain/owner矩阵、概念/文件/关系/精度验证通过并经CLI正式提交，无未记录的一等子系统缺口。
