# char.pub roleplay

[English](charpub-roleplay.md) | 中文

## 概要

私有实验性[回放库](../../packages/experimental/charpub-roleplay/README.zh.md)消费打包后的 char.pub 内容。[运行时](../../packages/experimental/charpub-roleplay-runtime/README.zh.md)在现有 Session 存储中记录精确请求与结算。显式的 [roleplay profile](../../packages/experimental/charpub-roleplay-runtime/PROFILE.md) 提供组合方式，不挂载 coding loop，也不提供客户端。

## 目录

- [类型与归属](#types-and-ownership)
- [持久请求](#durable-requests)
- [Cordis API](#cordis-surface)

<a id="types-and-ownership"></a>
## 类型与归属

| 类型 | 契约 |
|---|---|
| `ReplayInput` | 固定的 Artifact、运行时 profile、绑定、开场、显式能力支持和经过校验的 Source 正文输入。本地或草稿来源不授予 Registry 访问权限。 |
| `ReplayCommand` | 带标识的操作，包含角色视角、固定选择或完整 Plan，以及相关 judge/selector 证据。使用同一 ID 提交不同内容会被拒绝。 |
| `RoleplayProjection` | 重算的已提交状态、临时回放值、待处理请求及请求/结算映射。Session 事件始终是持久事实依据。 |
| `RoleplaySettled` | 成功时记录助手结果、流及完整后续状态。失败或取消时保留尝试证据，不提交拟议的 Story 效果。 |

回放包通过外部 SDK 校验输入和命令。运行时包拥有投影与结算类型。其[包契约](../../packages/experimental/charpub-roleplay-runtime/README.zh.md)定义取消、限额、支持的消息和恢复失败行为。

<a id="durable-requests"></a>
## 持久请求

`roleplay/opened` 仅存储一次固定输入。`roleplay/requested` 在发送前记录拟议命令、实际模型路由及精确有序消息。`roleplay/settled` 提交成功结果或记录失败尝试。这些必需事件在[持久化目录](../persistence-catalog.zh.md)中声明；不认识它们的读取方必须拒绝。

读取只投影事件，不发送请求。恢复会将已持久化但未得到响应的请求标记为中断，而不会重新发送。SDK 更新必须分别检查已存输入和回放兼容性；不能重写已提交的 [Session 存储代](../session-format-status.zh.md)来修改其中的结果。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxroleplayruntime--roleplayruntime"></a>

### `ctx.roleplayRuntime` — `RoleplayRuntime`

Session-backed one-request driver; it never mounts the coding loop or its prompt assembly.

```ts cordis-catalog
/**
 * Create a durable roleplay Session with one validated opening.
 * @param id - Unique stored Session identity; an existing identity is never overwritten.
 * @param input - Exact static artifact and opening inputs.
 * @param signal - Cancels before storage creation starts; an acquired header is completed with its opening.
 * @returns Initial reconstructed state after the durability barrier.
 */
create(id: SessionId, input: ReplayInput, signal?: AbortSignal): Promise<RoleplayProjection>

/**
 * Read committed Story state and any interrupted request without making a model call.
 * @param id - Existing roleplay Session identity.
 * @returns Reconstructed projection; a pending request never advances committed state.
 */
async inspect(id: SessionId): Promise<RoleplayProjection>

/**
 * Persist one exact request, send it once, then atomically record its outcome.
 * @param id - Existing Session; concurrent submissions fail before dispatch.
 * @param command - Fixed or evidenced decisions for the prospective request.
 * @param config - Explicit model route and output limit within the profile's reserved budget.
 * @param signal - Cancels preparation or generation. Once settlement storage starts, its outcome must be reconciled.
 * @returns Durable settlement. Exact retries return the stored outcome without another model call.
 */
submit(id: SessionId, command: ReplayCommand, config: LlmCallConfig, signal?: AbortSignal): Promise<RoleplaySettled>
```

Types: [LlmCallConfig](llm-streaming.zh.md) · [SessionId](core.zh.md)

Source: [`packages/experimental/charpub-roleplay-runtime/src/index.ts`](../../packages/experimental/charpub-roleplay-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
