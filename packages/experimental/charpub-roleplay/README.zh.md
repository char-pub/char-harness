---
description: "基于打包的 char.pub SDK 回放 Story 并显式请求 Jev/Laya 决策，重现状态、选择和消息。"
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-charpub-roleplay

[English](README.md) | 中文

运行时记录采用精确 JSON 摘要，保留 Unicode 形式、换行和尾部空格。旧规范化凭据不会被静默重写或通过旧算法回退接受，详见[升级指南](../../../docs/upgrade-guide/v0.2.0-rc.2/roleplay-exact-json-digests/guide.zh.md)。


## 概述

这个私有库使用 [`third_party/charpub`](../../../third_party/charpub/README.zh.md) 中已编译的 char.pub SDK 快照。它的回放操作执行调用者提供的 Story 命令，并在不访问网络的情况下重建状态、SelectionPlan 和实际模型消息。单独调用的 Jev 与 Laya 适配器通过各自明确的提供方协议请求判定和选材。该包不挂载 Cordis 插件，也不写入 Harness Session。

## 目录

- [使用此包](#use-this-package)
- [决策记录与提供方](#decision-records-and-jev)
- [验证](#verification)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

`createReplay(input)` 接收完整的 CreationArtifact，包含明确的 Release、Registry draft-build 或 local-build 来源，以及明确的 RuntimeProfile、角色绑定、能力支持声明和以 SDK 资产 ID 为键的资料正文。多个开局的 Story 必须指定 `start`。开场语言依次取 `locale`、profile 语言、产物默认语言。参与者 profile 要求初始输入和每条命令都指定 `for_participant`，不会继承前一条命令的视角。

`appendCommand(log, command, { signal })` 接收带品牌类型的 `commandId`、一个操作，以及固定 `selection` 引用或完整 `plan`，二者不能同时提供。完整 Plan 保留提供方身份、展开顺序、排序、分数和回退状态；回放会按重建输入校验它，不会换成固定选择器。操作包括 `input`、`confirm`、`enter-scene`、`set-present`、`prepare`，以及只修改历史的 `response`。response 追加助手历史，不准备另一次模型请求，也不占用下一次输入预算。`ReplayStep.turn` 是最新历史；`prepared_turn`、`plan` 和 `assembly` 对应最近一次实际准备。把旧 Plan 用于新历史会被拒绝；下一次请求应使用 `commandPreparation`。Runtime 请求事件将 response 命令保留给成功结算。玩家文本只追加用户历史，本身不能确认事实或切换场景。SDK 校验所有状态变化、可见性和选择。判定属于单条命令并记录其提供方身份，回放不会推断判定。缺少判定时保持未知，取反也不改变这一点。

完全相同的重复命令 ID 返回原日志，不重复施加效果。同一 ID 携带不同数据会抛出 `roleplay.command_conflict`。操作失败或调用取消时不返回新日志，也不修改参数。取消在回放前和返回新值前检查；同步计算不能被之后的事件循环任务中断。

`replay(value)` 校验反序列化的演练数据并重新计算每一步。结果包含开场、全部状态、精确 Plan、实际组装消息和调用者的能力支持报告。缺少必需能力会拒绝初始化。明确声明的降级及其原因会保留，但库不实现调用者的降级策略。

输入快照与哈希链条目能检测输入、命令、状态哈希、Plan 和消息哈希的修改，包括未同步修改 head 的截断。这些哈希是可重现性证据，不是签名：替换完整日志并重算哈希的人可以构造另一份有效演练数据。需要真实性保证的应用必须在这份数据之外保留可信 head。

<a id="decision-records-and-jev"></a>
## 决策记录与提供方

`commandPreparation(log, command, phase)` 返回可信引擎输入，不提交命令。先用 `before` 判定操作，再加入返回的判定，用 `after` 为预期状态选材。确认操作的判定输入与最终选材输入有意对应不同状态。不要把完整输入发送给提供方。

`createJevDecisions(config, transport)` 提供 `judgeStory(input, tasks, signal?)` 和 `selectContext(input, signal?)`。它使用固定版本的 [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) 及其[评估 API](https://docs.typesafe.ai/api)。每个阈值、超时、完整请求 token 预算和请求次数上限都必须明确提供。传输层显式接收密钥和基础 URL，不读取环境凭据。`judgeStory` 接收精确的作者 target/path 对，本地化实际 judge 叶子，返回 true、false 或 undetermined，不确认 Story 操作。阈值间隔和提供方失败都保持 undetermined。

选材先发送 SDK 的 `selectorCatalog` 和 `selectorView` 投影，之后只发送新展开目录的 DTO。候选元数据包含作者声明的 perspective、激活提示，以及仅指向当前视角可见身份的已解析关联；关联不会激活目标。元数据在实际暴露时计费，已有记录可能需要按[目录元数据升级指南](../../../docs/upgrade-guide/v0.2.0-rc.2/roleplay-catalog-metadata/guide.zh.md)明确审阅。它用批量 Noul 问题允许多选或空选。每次展开均先校验，再发送子项。完整请求计费包含重复的 history/focus，与 SDK 目录预算分开。提供方失败会返回带记录的 skip Plan；取消则抛出错误，不返回替代结果。调用者必须事先提供适合指定参与者的历史与焦点，因为选择器投影不会从历史中删除秘密。

`createLayaDecisions(config, transport)` 提供相同的两个操作，并使用独立的 `laya/systemone` 身份。它对接固定版本的 [Laya HTTP 实现](https://github.com/NandhaKishorM/laya/blob/6d942c92081fbc139e736bbd9ac0023223c29b7f/laya/serve.py)，记录协议版本、响应实际模型及路由、已校验概率、置信度字段和原始 JSON 摘要。模型必须明确选择 `english`、`multilingual`、`typed-decisions` 或 `auto`，任意模型名在本地拒绝。指定 checkpoint 时，响应路由必须匹配；自动模式发送上游 bundle 标识，保留实际选中的 checkpoint。即使 `noul` 很高，`low_confidence: true` 也一律让判定保持未确定，或拒绝候选且不展开。熵指标 `confidence` 不会被当成已校准的 `answer_confidence`。

除共用概率与操作限额外，Laya 必须显式配置 `max_questions`（最多 64）、`max_state_chars`（紧凑 JSON 的 Unicode 码点数，最多 50,000）、`max_request_bytes`（最多 2 MiB）、`max_response_bytes`、`max_len`、`head_max_len`（两者最多 8192）及 `min_confidence`。每次请求均发送并记录窗口和置信度控制。服务端可施加更紧的限额，其序列化状态的计数方式也不同。HTTP 端点只进行单窗口推理：这些限额和 SDK 估算计数器不能证明模型分词器覆盖了全部目录说明或历史消息。本地问题数、状态及字节限额会给出有记录的 skip/未确定结果，不丢问题或发送未记录的隐式批次。传输必须使用 HTTPS，显式启用的回环 HTTP 除外；`apiKey: null` 明确选择无认证的服务。响应字节、取消和超时限制涵盖正文传输，清理不会延迟已经中止的操作。

`makeDecisionRecord` 记录完整的去敏请求、已校验的类型化结果、公开配置、适配器身份和 SDK 输入摘要。两个适配器也会在可用时保存原始 JSON 响应摘要；格式错误的非 JSON 响应保留失败状态。配置包含请求的模型，成功响应保留实际模型身份。选择器证据绑定最终 Plan 摘要及其 selector/config/input。判定证据绑定关闭 discovery 的命令执行前输入，以及提供的提供方判定，包括 target、path 和 provider。多份判定记录可分别覆盖结果，但重复或没有证据覆盖的提供方结果会被拒绝。所有非 fixed/none Plan 都要求选择器证据，所有 fixed/manual 之外的判定都要求匹配的判定证据。fixed/manual 决策仍是明确的作者输入。这些记录属于命令元数据，不插入模型消息。

回放格式版本 2 包含完整 Plan 和证据，不接受版本 1 演练数据。记录的结构化数据会递归拒绝传输头、凭据字段和原始基础 URL。这不是文本脱敏：作者说明或历史本身可能包含敏感文本。日志仍属于私有演练数据。哈希校验回放一致性，不验证提供方概率是否校准良好或远端回答是否真实。

<a id="verification"></a>
## 验证

安装锁定 tarball 后，在 Harness 根目录运行：

```sh
pnpm run test:roleplay
```

Jev 请求快照位于 `tests/jev.test.ts.snapshot`；协议测试使用注入的 fake fetch，包含响应正文交付期间的超时。Laya 测试位于 `tests/laya.test.ts`，使用注入响应及真实本地 HTTP 服务核对固定上游协议，不运行上游推理或加载权重。没有执行真实模型请求。

包内测试使用 Node 测试运行器和 `tsx/esm`，覆盖仓库支持的 Node 版本。它们不是应用，也不是新的可执行入口。测试断言 char.pub 解析到已安装的 `dist/index.js` 导出，而非跨仓源码路径；根级消费者冒烟测试另行验证输出的 JavaScript。

<a id="understand-the-implementation"></a>
## 理解实现

输入由已安装的 char.pub SDK schema 解析。来源字段标识构建输入；这个离线库不校验 Registry 权限、草稿过期或签名下载授权。资料正文必须显式提供，并按资产摘要校验。Trace 保留根身份和语义摘要。`startSession` 恰好提供一次开场；`confirm`、`enterScene`、`setPresent` 和 `toTurnStory` 负责状态语义。`createPreparationCatalog`、`fixedSelection` 和 `prepareContext` 负责选材及最终消息。本包不复制内容 schema、条件求值器或提示词组装器。每次追加先回放原日志，再构造独立条目，因此没有需要对账的可变会话缓存。

本库不发布 `./invariant` 配套入口：没有可能发生偏离的注册表或共享运行时观测。回放比较和包内测试检查返回的演练数据。

<a id="model-experience"></a>
## 模型体验

### 准备后的消息输出

#### 模型看到什么

`createReplay` 和 `replay` 不发送请求。显式调用 Jev 或 Laya 时，它只看到所选视角的历史/焦点、候选目录说明及其可见元数据，或精确的作者判定问题，不接收产物、状态变量、绑定、覆盖层或候选正文。回放结果提供 SDK 为调用者所选参与者、开场、历史、Story 状态、资料引用和锁定策略准备的实际消息。演练输入包含完整产物和提供的资料正文；调用者不得把日志或完整输入转发给参与者模型。

#### Token 影响

SDK 估算并执行明确 profile 的上下文预算和输出预留预算。判定请求还使用明确的目录预算、完整请求预算和请求次数上限。固定选择只在准备后的消息中暴露获准的资料正文。日志哈希与命令元数据不加入模型上下文。

#### KV Cache 影响

本库不创建提供方缓存。命令可能改变前面的准备内容、顺序或参与者投影；调用者必须比较实际消息，才能判断前缀是否可复用。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 初始开场判定目前只接受 fixed/manual 提供方，因为没有模型开场回执输入。自动判定记录在后续命令中。
- 离线回放只接受 `estimate` tokenizer。精确 tokenizer 身份需要后续异步加载器和对应回放元数据。
- 这是内存中的离线演练格式，不是持久化 Harness Session 历史；不包含持久化、崩溃恢复、并发写入者、Session fork 或 SessionEventMap 集成。
- 本包没有 roleplay profile、agent loop（智能体循环）集成、工具执行、生成模型调用。Jev 协议测试使用 fake HTTP 响应；Laya 还通过真实回环 HTTP 服务使用路由器响应替身。不代表已验证真实推理端点、模型权重或决策质量。准备后的消息是本包唯一渲染输出，不注入上游历史或 system-prompt 服务。
- 资料必须从本地提供；Registry 授权、资产下载和 OAuth 不属于本库。用于组装的正文由 SDK 校验。
- 调用者提供能力支持及降级说明。说明不能证明外部运行时实现了相应行为。
- 每次追加都会回放整份日志。不可信的超大日志需要应用在解析前限制大小和命令数量。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
