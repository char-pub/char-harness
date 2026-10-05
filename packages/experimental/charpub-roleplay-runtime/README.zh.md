---
description: "使用 Harness Session 和 LLM 服务持久化角色扮演请求与已提交 Story 状态。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-charpub-roleplay-runtime

[English](README.md) | 中文

运行时记录采用精确 JSON 摘要，保留 Unicode 形式、换行和尾部空格。旧规范化凭据不会被静默重写或通过旧算法回退接受，详见[升级指南](../../../docs/upgrade-guide/v0.2.0-rc.2/roleplay-exact-json-digests/guide.zh.md)。


## 概述

`ctx.roleplayRuntime` 负责基于固定 char.pub 产物生成文本。它通过[回放库](../charpub-roleplay/README.zh.md) 使用打包 SDK，经现有持久化服务保存必需的 Session 事件，并通过 `ctx.llm` 派发精确记录的请求。其组合不含 coding agent loop（编程智能体循环）、system-prompt 服务或工具。

## 目录

- [使用此包](#use-this-package)
- [服务](#service)
- [Registry 访问](#registry-access)
- [存储与恢复](#storage-and-recovery)
- [配置与验证](#configuration-and-verification)
- [可选本地浏览器入口](#optional-local-browser-entry)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

私有 bundle 在 [cordis.patch.yml](cordis.patch.yml) 中声明组合层。[profile 参考](PROFILE.md) 负责明确配置和已验证的命名 profile 组合。没有默认 profile 包含此层；生成提供方和调用入口需另行提供。

<a id="service"></a>
## 服务

`create(id, input, signal?)` 校验开场并将其持久化，再返回重建状态。已有 ID 永不覆盖。取消可以在存储创建开始前拒绝；取得头部之后，初始化会完成开场，避免迟到的取消留下只有头部的会话。

`submit(id, command, callConfig, signal?)` 接收带证据或固定的 Story 命令，以及明确的 provider、model 和正数 `maxTokens`；后者不得超过产物消费者 profile 的输出预留预算。它先解析提供方实际配置。如果模型宣告的上下文窗口较小，则拒绝不匹配的 profile。准备消息必须是纯文本，不接受附件。

requested 事件在派发前刷入存储。驱动只发送 `requestMessages(requested)`，保持 SDK 角色、顺序和文本，不另加历史或提示词组装。成功要求流末尾只有一次终止 stop、非空文本，且没有工具或媒体内容。推理内容保留在本次尝试的记录中，不追加到共享对话。成功结算包含完整的已提交 Story 状态、turn 和助手响应；失败或取消的尝试不推进 Story 事实。

完全相同的重复命令 ID 和原始调用配置返回已记录结果，不再次调用模型。更改内容后复用会被拒绝。同一 Session 上的并发操作报忙。重新打开时，未回答请求先结算为 interrupted，再考虑下一条命令；不会自动重新派发。已停止的 Story 可供检查，但拒绝新的生成；触发结局的请求可以完成最后一次回复。

`inspect(id)` 通过明确的异步存储读取重建当前已提交状态和待处理请求。服务没有独立可写的 Story 缓存。dispose（资源释放）会取消活动操作，并等待其存储句柄关闭。

### 玩家回合与撤回

`play(session, intent, config, signal?)` 接收原始文本或当前可用的 `choice_id`、稳定命令 ID 与 `expected_revision`。`config` 指定 `generation`、`decisions`，以及最低置信度、动作数、决策调用数和决策总 token 限额。两条 LLM 路由由本地 profile 决定，Registry 内容不能替换。派发前校验作者声明的受控玩家、选项和输出预留。`submit` 保留为现有调用者使用的显式命令 API。两条 API 共用已消费的命令身份；经一条 API 使用的 ID 不能通过另一条成为新尝试，包括规划中止后的 ID。

Director 接收本次输入、投影后的对话、本地化场景开场与目标描述及 judge 问题、已声明的场次关联、条件表达式及 Core 当前真值，以及已达成目标，只返回目标 ID、类型化判定和置信度。本次已解析的玩家消息单列为最后的 `latest_input` 字段；`interaction.history` 完整保留此前对话作为背景。Core 按顺序校验提议动作。只有已声明的 judge target/path 对能成为证据；未声明条目被忽略，重复条目只让对应叶子变成未确定，不丢弃其他独立有效判定。未知目标、缺少证据、低置信度和无效响应不产生效果。随后选材依据投影描述逐步展开 SDK 目录，不接收候选正文、任意变量或绑定。选材不可用时记录 skip Plan，保留 required/direct 上下文。只有生成成功后，叙述、动作和玩家对话才一起提交。

符合条件的结局在叙述成功后成为 `pending_ending`；提出结局不会应用结局效果或设置 stopped。多个符合条件的结局保持含糊。提案保留私有目标/证据与公开展示字段：只有作者声明为 `listed` 的结局会在确认前展示标题/描述，hidden 和 on-reach 结局仅展示玩家的触发输入。叙述收到明确的待确认结局指令，可以继续当前场景，不得声称终局后果已发生。带版本的指令区分结构化确认与对话中的普通同意；[Replay 约定](../charpub-roleplay/README.zh.md#use-this-package) 保留旧指令字节。

确认使用新的 `play` 意图，包含 `confirm_ending: { proposal_id }`、普通确认文本和最新 `expected_revision`，不能同时包含 `choice_id`。服务端校验自己保存的待确认提案和状态，把已记录判定值作为玩家手动确认，跳过导演/选择器调用并准备一次叙述。只有成功结算才应用结局。失败或中断保留提案，重试已消费 ID 永远不会再次派发。另一条成功普通回合会替换或清除提案；撤回连同 Story 状态恢复此前的待确认提案。没有提案元数据的历史命令保留原有自动结局行为。

每条决策请求都在派发前追加并刷盘，响应保留私有流证据。`max_decision_tokens` 按整回合累计估算输入与预留输出，取得实际用量后改按报告值计费；tokenizer 估算与模型置信度不构成校准保证。`max_decision_calls` 限制 director 与 selector 的总尝试次数。决策限额可以抑制后续调用，不包含叙述调用。取消会结束本次尝试而不发布待提交事实。

`inspect().revision` 绑定包括失败和撤回在内的全部保留事件，`head` 则标识当前逻辑 Replay。相同的已结算请求 ID 返回原结果，不再派发。未完成 ID 需先通过 `lookupPlay` 检查，再以新请求和 `recover_interrupted: true` 恢复；恢复只结束旧尝试，不重发旧请求。`rewind(session, { id, expected_revision })` 追加记录，恢复上一条成功玩家回合之前的状态，不调用模型。旧结果仍可查询，并带 `superseded: true`；旧 ID 永远不会在新分支重新应用。返回的 resolution 含私有动作代码与状态差异，客户端展示前必须做玩家视图投影。

<a id="registry-access"></a>
## Registry 访问

`createRegistryClient` 使用 `oauth4webapi` 发现同源 OAuth issuer。调用方提供 Registry origin、issuer、手动注册的公共客户端 ID、精确回调 URI、请求 scopes，以及正数 HTTP 字节与时间上限。`beginAuthorization` 返回浏览器导航地址；`completeAuthorization` 验证一次性 state、回调 URI 并完成 S256 兑换。`refreshAuthorization` 通过单个进行中刷新轮换凭据。撤销排在正在刷新的操作之后。刷新失败或结果不确定时清除凭据，绝不重试兑换。Token 和 PKCE 状态只留在进程私有内存；dispose 中止并等待正在进行的 HTTP 操作退出，在本地遗忘凭据，不宣称远端已撤销。产物返回值和 Session 事件均不含凭据。

`release(exact)` 按 ID 回执验证精确发布根，并核对下载产物的原始字节。`receipt(buildID)` 读取草稿构建状态；`draftBuild(buildID)` 要求 ready、未到期的回执与完整草稿来源匹配。产物下载重定向使用无凭据请求，并限制协议、跳转次数、完整响应大小和读取期限。HTTP 仅允许显式启用的本地开发回环地址。读取受 Registry 当前权限约束；已返回产物是取得的快照，不保证未来网络读取仍被授权。

`releaseSource(exact, signal?)` 先验证精确发布产物，再按回执中的当前地址和固定标签读取不可变作者定义。它将源码的 canonical 摘要、原始 ref 和作品 ID 与已验证版本核对，返回 `{ release, source }`，其中 `source.creation` 为规范化定义，`source.revision` 来自 Registry。源码摘要并不以密码学方式绑定 Revision ID，该映射由已认证 Registry 响应提供。取消不返回部分结果；来源缺失、拒绝访问或不匹配时，绝不回退到 IR 或最新版。此读取不检查或上传 Runtime Session，不创建投稿，也不确认贡献权利。

`sourceTexts(loaded, preparation, signal?)` 以精确 Plan 调用 SDK 加载清单，仅请求所选或必需正文，并核对 source ID、asset ID、digest 和 UTF-8 字节。将验证后的正文交给现有 runtime 输入或 SDK preparation。Release、草稿回执/产物与 Source 读取接受可选 AbortSignal。调用方自带产物不能替代此客户端验证过回执的产物。`createWorkingDraft`、`derive`、`contribute` 每次 POST 都需要明确确认，结果不确定时绝不重试写入。接口不提供发布或修改已有草稿。确认表示调用应用取得了用户意图；Registry 独立验证 OAuth scopes、权利和当前资源权限。

<a id="storage-and-recovery"></a>
### 本地结局投稿

`createEndingProposals({ registry, inspect })` 在创建时固定现有客户端与权威 Session 读取器。`prepare({ session, ending, title, description?, rights_ack }, signal?)` 读取已提交的已发布 Scenario 及其精确 Registry 源码。调用方提供由人或外部模型撰写的明确 Ending 对象；准备阶段既不调用模型，也不把模型输出当作确认。它使用 Core 的对象规范化、组合摘要、三方合并与静态检查，只添加新 Ending 并更新结局顺序。已有结局 ID、待完成请求以及本地或草稿根都会被拒绝。

返回候选包含当前目标地址、原始精确来源与 Revision、来源版本根定义的分级/许可/内容提示、完整 Ending、完整拟发送请求、本地 Session/head/状态摘要和授权版本。调用方必须沿用已取得产物的聚合评级遮挡（`release.artifact.meta.rating`），不能用根定义的 `source_rating` 替代。来源版本元数据不是目标当前草稿的政策；Registry 会重新检查当前权利与权限。向用户展示完整请求和元数据，经独立审阅动作后，以同一明确授权调用 `submit(candidate, { candidate_digest: candidate.digest, rights_ack }, signal?)`。副本、内容改动、确认不符、已提交 head 或授权版本变化都会被拒绝。Session 在派发准备前重新检查；刷新凭据或 HTTP 期间不会锁住后续游玩，后续游玩也不会改变已审阅的历史快照。

只会发送请求白名单内的投稿字段，且包含 `agent: true`；Session 标识、摘要、历史、已加载 Source 正文、流与凭据不在请求中。获取 Token 后、POST 前再次核对同一授权；同一授权的刷新不改变版本，登录、撤销或凭据丢失会使旧确认失效。提交前已取消则不发请求。候选一旦尝试提交，在本进程内始终标为已使用，包括取消或失败。明确的 HTTP 4xx 拒绝保留原错误；传输不确定、派发后取消或无效响应报告 `roleplay_proposal.outcome_unknown`。应核查 Registry 结果，不要盲目重新准备后重试。本库不提供跨进程持久幂等、自动提案界面、完整聊天转剧情、接受或发布能力。

### 从已审阅局面创建新续作

`createStoryContinuations({ registry, inspect })` 固定已认证客户端与已提交 Session 读取器。`prepare({ session, namespace, name, display_name, opening, agent, rights_ack }, signal?)` 要求已发布 Scenario、明确的新开场文本和 agent 参与声明。它读取精确 Registry 作者源，并按该定义验证已提交状态。返回审阅项展示新作品地址、精确来源与 Revision、来源及聚合内容提示/分级、许可、完整请求和进度重置。准备阶段只读取；新作品身份由 Registry 分配。

请求仅将当前场次、在场角色、完整变量与知情、调用方开场文本作为 `from_play`，连同精确来源及普通续作字段提交。Registry 将它们写成新的静态开局，保留背景和带作用域的引用，移除旧可执行剧情、场次目标、入场知情与开局效果。不复制旧进度与对话。审阅项明确仅开局场次被访问，reached/ended/happened 清空且 stopped=false。此操作创建新故事，不继续原剧情，也不支持保留运行状态的 Remix。

先展示完整审阅项，包括可能私密的变量/知情值与开场文本，再独立调用 `submit(review, { candidate_digest: review.digest, rights_ack }, signal?)`。工厂重新核对原审阅实例、精确字节、已提交 head/状态与授权版本，沿用结局投稿的确认和单次尝试规则。它在派发准备前固定已确认的历史局面；之后不锁住游玩，也不允许游玩暗改请求。提交前取消不发请求；尝试提交后，结果不确定时报告 `roleplay_continuation.outcome_unknown` 并消费审阅项。准备另一请求之前先核查结果。

成功只在用户本人的 namespace 创建新私有草稿。Registry 检查当前来源读取权、改编许可与资产授权；OAuth 不能通过此客户端编辑该草稿或发布。`agent: false` 不清除来源已有的 agent 标记，OAuth 本身也不表示 agent 创作。请求不包含 Session 标识、历史、Source 正文与凭据。此操作不产生 Session 事件、模型调用、自动摘要或发布。

### 合成预览导出

`createRuntimePreviewExports({ inspect })` 通过创建时固定的 Session 读取器取得已提交 Story 状态。`prepare({ session, history, bindings, for_participant?, story_guidance? }, signal?)` 必须接收明确提供的合成历史和角色绑定，不会用私有运行消息或人物描述自动填充。per-agent 配置要求明确选择视角。共享 SDK 校验器检查精确来源产物、有效 Preset、实际语言、tokenizer 版本、Story 状态、绑定、说话人与 1 MiB 载荷上限。Release、Registry 草稿构建与本地构建根保留真实身份；过期草稿来源会被拒绝。

先完整审阅 `payload`，包括变量与知情状态，再独立调用 `export(review, { candidate_digest: review.digest }, signal?)`。工厂拒绝候选副本、内容改动、待完成请求以及已变化的已提交 head 或状态。它返回 `{ payload, json }`，不发网络请求、不触发下载、不写文件；不变快照的重复确认会产生相同字节。调用前已取消时不读取 Session；读取后取消不能撤销那次读取，但不会返回文件或写入任何内容。导出文件不含本地审阅/Session 标识、确认摘要、OAuth 状态、Source 正文、选材 Plan 或运行时 overlay，仅包含共享交接字段和明确提供的合成历史与绑定。

导出状态本身可能含私有信息。调用方须完整展示，沿用产物聚合评级遮挡，并让用户决定保存或分享位置。摘要只能检测变化，不认证发送者，也不授予接收方作品或资产读取权。Web 导入须独立审阅文件，并以选定产物重新验证。将它应用到新草稿是另一次明确操作，不是保持同一身份的重放。把成功预览保存为作者测试还需另行确认，可能保留另外取得的 Source 整篇正文；本导出器不执行这两步。

## 存储与恢复

`roleplay/opened` 只保存一次固定 SDK 输入。`roleplay/requested` 包含命令、原始与解析后的调用配置、原准备消息，以及校验后的状态/Plan/请求摘要。`roleplay/settled` 绑定请求并保留紧凑的模型流、用量和结果。纯回放会重新校验全部内容。回合规划和撤回还保留 `roleplay/turn-started`、`roleplay/turn-requested`、决策请求与结果、回合中止及只追加的撤回记录。旧运行时读取这些日志前，请先查看[回合升级指南](../../../docs/upgrade-guide/v0.2.0-rc.2/roleplay-player-turns/guide.zh.md)。这些必需事件登记在生成的持久化目录中；不认识事件的读取器会拒绝日志。[持久化变更记录](../../../docs/persistence-changes/2026-09-30-charpub-roleplay-events.zh.md) 说明兼容性。[客户端来源扩展](../../../docs/persistence-changes/2026-10-01-charpub-client-origin.zh.md) 在固定产物的贡献者元数据中保留可选外部客户端 ID；这些标签不能认证 Registry 请求。[前一 SDK 恢复样本](tests/fixtures/pre-registry-sdk/README.zh.md) 保留原始字节，并验证 pending 请求被中断且不派发。

每个候选事件转换都在追加前通过回放校验，因此被拒绝的写入方操作不会在磁盘留下不可读事实。追加和刷盘构成提交区间。开始写入后，取消不能保证回滚。存储失败可能已将请求或成功结算写入磁盘；操作会拒绝，调用者必须检查状态或用相同命令 ID 重试，以核对持久化结果。驱动不会将存储错误变成自动第二次模型调用。JSONL 的现有写入所有权排除其他进程。

Session 日志是唯一持久记录。投影返回的 `ReplayLog` 是临时重建值。这些日志包含产物、资料正文和私有决策证据，不能整体发送给参与者模型。

<a id="configuration-and-verification"></a>
## 配置与验证

`timeout_ms`、`max_event_bytes` 和 `max_stream_bytes` 是必填配置。超时覆盖活动操作；开始写入后，提交/关闭会在不可取消的区间内完成。每个完整存储事件均受大小限制，流块 JSON 字节在保留前计数。输出超限会使本次尝试失败，不提交拟议事实。

测试通过 Loader 启动真实 Session、JSONL、LLM（大语言模型）及 runtime 配置项，并显式提供不联网的模型适配器。它们覆盖消息一致性、视角切换、关闭/重开、幂等、取消、dispose、中断请求与存储屏障对账。纯投影测试也拒绝篡改字段和格式错误的成功流。这些检查不调用真实模型。

本包不发布运行时不变量配套入口，因为每次请求和结算在派发或返回前都针对同一重建日志校验，没有单独维护的请求或 Story 缓存可供比较。

独立 Registry 浏览器测试使用仅测试用途的 IPC 桥，不是应用启动器。先构建 runtime 包，再用 `node node_modules/typescript/lib/tsc.js -p packages/experimental/charpub-roleplay-runtime/tests/registry/tsconfig.fullstack.json` 编译测试桥。char.pub checkout 通过 `E2E_HARNESS_ROOT` 在 `fullstack-harness` 测试中选择这个独立 checkout；桥仅导入已编译包导出，OAuth 回调 code 和 token 留在其进程内。

<a id="optional-local-browser-entry"></a>
## 可选本地浏览器入口

[roleplay profile 指南](PROFILE.md) 说明显式启用的 `./app` 插件与 `app.patch.yml`。通过 `dsh --profile roleplay` 启动；基础 bundle 本身仍没有前端。本地回环欢迎页链接到已配置的 Registry 供用户选择作品；手动 JSON 入口位于高级区域。页面审阅 Registry 精确启动请求、独立授权，再由用户选择开局、视角和运行时角色绑定后创建持久 Session。Registry、OAuth 回调与模型路由仅来自本地 profile 配置，启动请求不能替换它们，也不能携带凭据或对话。

页面支持带 Story 的内容与 estimate tokenizer。它使用配置的 LLM 做受约束的回合决策、渐进选材与叙述；开局判定仍需显式提供。新构建需要确认新建会话。旧标签页保留本地不透明句柄，不能把回复发入后来创建的 Session。角色的私密描述与公开 outward 描述分别填写。

随附的 DeepSeek profile 声明 `multiple_system_messages: false`。SDK 在记录请求前合并相邻的 system 区域，使它们的完整正文保留在适配器实际生效的 system 提示词中。此 profile 不兼容用对话历史分隔 system 消息的 Preset。已有 Session 和锁定组装 profile 的产物保留各自的能力声明；本地 profile 的修改只适用于未锁定产物 profile 的新 Session。

页面是由同一个 profile HTTP 插件提供的已编译 React 客户端。主视图呈现对话、可见人物和当前场次；Registry/模型状态与技术 JSON 位于次级位置。浏览器接收玩家 DTO，不接收原始 Story 知情/变量全表、Source 正文或 OAuth 凭据。人物角色与目标采用和上下文准备相同的 SDK 视角过滤。

本机记录来自既有 Session 持久化提供方。列表每次有界读取一页日志，无法读取的记录会明确显示。选择记录时，先重新核验其精确 Registry 来源和当前授权，再发出新的操作句柄；过期草稿构建和不可访问来源会失败，不改日志、不替换为最新版。记录标识是供本机界面草稿使用的稳定不透明摘要；活动句柄仍只属于当前进程，两者都不授予 Registry 访问权。刷新页面可以读取当前已提交快照，不创建另一个 Session。

每次回复携带一个客户端请求 ID。相同提交并发时共用操作，完成后的重复请求恢复已保存的结算；同 ID 换正文会被拒绝。响应丢失后先查询同一个请求，再提供明确重试。取消同时指定 Session 句柄和请求，旧取消不能停止新回复。界面展示真实的发送中和结算结果，不模拟逐 token 流式输出。

恢复未完成请求时只读日志。普通发送保持禁用，直到用户明确选择结束未完成请求并发送新回复。新请求使用新的 ID 与 `recover_interrupted: true`；既有驱动将旧请求记为 interrupted，然后只派发一次新回复。旧请求 ID 不会触发另一次模型调用。停止的故事仍可读取，但不能继续生成。

授权状态表示本地可用授权，不是远端有效性探测。模型状态报告已配置的提供方/模型，以及其密钥引用是否已配置、由哪个来源层提供、能否写入。[app-settings.ts](src/app-settings.ts) 使用与 DeepSeek Harness Web 设置页相同的服务提供设置页面：`llm.listConfigurableProviders()` 列出模型提供方，`credentials.set/unset` 保存密钥（本地提供方写入 `$DSH_HOME/.credentials.yaml`），`settings.describe/mutate` 读写 profile patch 中的可热更新字段，`readPluginInventory` 列出 Loader 条目。写入以读取时的 revision 防止覆盖；由命令行叠加层占用的条目报告为只读，来自启动环境的密钥同样只读。app 自身的 HTTP 限额不作为表单提供。已配置的密钥不保证密钥或网络可用。加载页面、检查状态和写入设置都不会调用推理端点，任何响应都不返回凭据值。

预览导出使用独立空白的合成绑定表单和明确的摘要，不预填游玩绑定、不复制聊天记录。修改合成字段会使已显示的文件审阅失效；确认仍核对已提交 head 和候选精确摘要。文件排除 Source 正文与凭据。入口检查 Host、Origin、请求 nonce、字节和操作期限；取消会传到 Registry 读取和模型生成。取消期间已经完成的存储提交仍是事实依据。


<a id="model-experience"></a>
## 模型体验

### 已记录的准备消息

#### 模型看到什么

叙述完整采用 requested 事件里记录的 SDK 准备角色和文本，包括回合 overlay。Director 与 selector 调用接收各自记录的单条 system 指令与投影 JSON 输入。不提供编码工具。Source ID 和回执留在私有日志中。DSH 要求 assistant 角色消息带模型元数据，因此传输把准备后的历史映射到明确合成的 `char.pub` / `prepared-history` 来源；原 SDK 来源 ID 与实际新解析的模型路由另行保留。

#### Token 影响

SDK 执行声明的上下文预算和输出预留预算。追加成功助手回复会更新历史，不准备另一次请求，也不重复预留输出预算；后续命令准备新 Plan。`prepared_turn` 标识最近一次实际准备所对应的输入。

#### KV Cache 影响

新视角、Story 状态或选材可改变先前请求文本与顺序。不保证缓存复用，也不向请求插入重复的通用 Session 内容。


## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 这是独立驱动，不是 `AgentRegistry` 实现。默认 Web/SDK transcript（文本记录）、coding-loop 恢复和通用 Agent 工具不解释其请求。
- 对话历史属于共享场景对话。切换参与者只过滤受控设定资料，不按受众过滤此前发言；私聊需要明确的受众投影之后才能使用该路径。
- 准备后的助手历史带合成传输元数据，不保留原提供方回放状态。实际新生成的配置和流仍会记录。
- 初始开场判定和模型开场回执仍由调用者负责。配置的回合模型可能误解意图；置信度阈值与 Core 校验约束其效果，撤回允许玩家修正已结算回合。在线模型质量仍需单独评估。
- Registry 客户端仅在进程内存中保存凭据。持久凭据库、多进程刷新协调、在线模型质量和高级游戏自动化仍是独立工作。固定 Session 已取得的 Source 正文作为私有输入保留；此客户端不会在服务端撤权后追溯擦除这些正文。
- 原型每次操作都重建历史。大 Session 检查点和归档分页尚未实现；事件和流字节上限不限制 Session 总长度。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
