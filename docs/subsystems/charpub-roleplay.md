# char.pub roleplay

English | [中文](charpub-roleplay.zh.md)

## Summary

The private experimental [replay library](../../packages/experimental/charpub-roleplay/README.md) consumes packed char.pub content. The [runtime](../../packages/experimental/charpub-roleplay-runtime/README.md) records its exact requests and settlements in the existing Session store. An explicit [roleplay profile](../../packages/experimental/charpub-roleplay-runtime/PROFILE.md) provides the composition; it does not mount the coding loop or supply a client.

## Table of Contents

- [Types and ownership](#types-and-ownership)
- [Durable requests](#durable-requests)
- [Cordis API](#cordis-surface)

<a id="types-and-ownership"></a>
## Types and ownership

| Type | Contract |
|---|---|
| `ReplayInput` | Fixed Artifact, runtime profile, bindings, opening, explicit capability support and verified Source text inputs. Local or draft origins do not grant Registry access. |
| `ReplayCommand` | Identified operation with a participant view, fixed selection or complete Plan, and any judge/selector evidence. Reusing an ID with different content is rejected. |
| `RoleplayProjection` | Recomputed committed state, temporary replay value, pending request and request/settlement maps. The Session events remain the durable authority. |
| `RoleplaySettled` | Success records the assistant result, stream and complete post-state. Failure or cancellation retains attempt evidence without committing proposed Story effects. |

The replay package owns input and command validation through the external SDK. The runtime package owns projection and settlement types. Its [package contract](../../packages/experimental/charpub-roleplay-runtime/README.md) specifies cancellation, limits, supported messages and recovery failures.

<a id="durable-requests"></a>
## Durable requests

`roleplay/opened` stores the fixed input once. `roleplay/requested` records the proposed command, effective model route and exact ordered messages before dispatch. `roleplay/settled` commits success or records an unsuccessful attempt. These required events are declared in the [persistence catalog](../persistence-catalog.md); an unknown reader must reject them.

Reading projects events without sending a request. Recovery marks a persisted unanswered request as interrupted instead of resending it. SDK updates must independently check stored input and replay compatibility; committed [Session generations](../session-format-status.md) are not rewritten to change their recorded results.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [LlmCallConfig](llm-streaming.md) · [SessionId](core.md)

Source: [`packages/experimental/charpub-roleplay-runtime/src/index.ts`](../../packages/experimental/charpub-roleplay-runtime/src/index.ts)
<!-- END GENERATED cordis-surface -->
