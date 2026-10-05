---
description: "Story replay and explicit Jev/Laya decisions using packed char.pub SDKs, with reproducible state, selections and messages."
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-charpub-roleplay

English | [中文](README.zh.md)

Runtime records use exact JSON digests for original text, including Unicode form, line endings and trailing spaces. Older normalized receipts are never silently rewritten or accepted by fallback; see the [upgrade guide](../../../docs/upgrade-guide/v0.2.0-rc.2/roleplay-exact-json-digests/guide.md).


## Summary

This private library consumes the compiled char.pub SDK snapshots in [`third_party/charpub`](../../../third_party/charpub/README.md). Its replay operations run caller-supplied Story commands and reconstruct their states, SelectionPlans and actual model messages without network access. The separately invoked Jev and Laya adapters request judgments and selections through their explicit provider protocols. The package does not mount a Cordis plugin or write a Harness Session.

## Table of Contents

- [Use this package](#use-this-package)
- [Decision records and providers](#decision-records-and-jev)
- [Verification](#verification)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`createReplay(input)` accepts a complete CreationArtifact with an explicit Release, Registry draft-build or local-build origin, an explicit RuntimeProfile, role bindings, a capability-support declaration and source text keyed by SDK asset ID. A multi-opening Story requires `start`. The opening uses `locale`, then the profile locale, then the artifact default. A participant profile requires `for_participant` in the initial input and again on each command; it is never inherited from a preceding command.

`appendCommand(log, command, { signal })` accepts a branded `commandId`, one operation, and either fixed `selection` references or a complete `plan`, never both. A complete Plan keeps its provider identity, expansion order, ranking, scores and fallback status; replay validates it against the reconstructed inputs rather than replacing it with a fixed selector. Operations are `input`, `confirm`, `enter-scene`, `set-present`, `prepare`, atomic `turn` and the history-only `response`. A response appends assistant history without preparing another model request or spending the next input budget. `ReplayStep.turn` is the latest history; `prepared_turn`, `plan` and `assembly` refer to the latest actual preparation. Reusing that old Plan with the new history is rejected; use `commandPreparation` for the next request. Runtime request events reserve response commands for successful settlement. Player text only appends user history; it cannot itself confirm a fact or move the scene. The SDK validates all state changes, visibility and selections. Judgments belong to one command and record their provider identity; replay does not infer them. Missing judgments remain unknown, including under negation.

A `turn` contains one original input, optional authored `choice_id`, ordered confirmations or scene transitions, and matching accepted/skipped assessments. The SDK resolves `Story.player` through `playerInputMessage`; an explicit conflicting speaker is rejected, without guessing a cast member from names or the `user` binding. Choice intents become dialogue evidence, not effects. `commandPreparation(..., "before")` includes this new player message before judges run; actions then pass through Core in order, and the final Plan binds their prospective state. Replay applies the entire operation or returns no new log. The next narration receives a short state overlay that distinguishes established effects from unconfirmed attempts.

Choice availability uses the committed turn’s judgments, matching the displayed choices; judgments supplied for new actions cannot authorize that same input. Optional `ending_proposal` metadata records an eligible ending without applying it. The proposal binds its source turn, parent head/revision, prospective state and original provider judgments; only its `public` fields belong in a player view. A later `ending_confirmation` binds the exact proposal to one ending action and the same leaf values marked as manual confirmation. The narration overlay distinguishes pending and confirmed endings. Turns without these optional fields retain their recorded action semantics.

An exact repeated command ID returns the existing log without reapplying effects. Reusing that ID with different data throws `roleplay.command_conflict`. A failed operation or cancelled call returns no new log and does not mutate its argument. Cancellation is checked before replay and before the new value is returned; synchronous computation cannot be interrupted by a later event-loop task.

`replay(value)` validates deserialized exercise data and recomputes every step. The result includes the opening, all states, exact Plans, actual assembled messages and the caller's capability-support report. Missing required capabilities reject initialization. Explicitly declared degradation remains visible with its reason; the library does not implement the caller's degradation policy.

The input snapshot and hash-linked entries detect edits to inputs, commands, state hashes, Plans and message hashes, including truncation without a matching head. These hashes are reproducibility evidence, not signatures: someone who replaces the complete log and recomputes its hashes can produce another valid exercise. An application needing authenticity must retain a trusted head outside this data.

<a id="decision-records-and-jev"></a>
## Decision records and providers

`commandPreparation(log, command, phase)` returns trusted engine input without committing a command. Use `before` to judge an operation, then add the returned judgments and use `after` to select material for its prospective state. For a confirmation, the judge input and final selection input intentionally describe different states. Never send this full input to a provider.

`createJevDecisions(config, transport)` exposes `judgeStory(input, tasks, signal?)` and `selectContext(input, signal?)`. It uses the pinned [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript) and its [evaluation API](https://docs.typesafe.ai/api). Every threshold, timeout, whole-request token budget and request-count limit is explicit. Transport takes an explicit key and base URL; it does not read environment credentials. `judgeStory` accepts exact authored target/path pairs, localizes the actual judge leaves, and returns true, false or undetermined without confirming a Story operation. The threshold gap and provider failures remain undetermined.

Selection sends the SDK's `selectorCatalog` and `selectorView` projections, then only the newly expanded directory DTO. Candidate metadata includes declared perspective, activation hints and resolved associations only to identities visible in the current view. Associations do not activate their targets. Metadata is charged when exposed; existing recordings may need explicit review under the [Catalog metadata upgrade guide](../../../docs/upgrade-guide/v0.2.0-rc.2/roleplay-catalog-metadata/guide.md). It uses batched Noul questions to allow multiple or zero selected leaves. Each expansion is validated before sending its children. Whole-request accounting includes repeated history/focus; it is separate from the SDK's directory budget. Provider failures return a recorded skip Plan; cancellation throws instead of returning a substitute result. The caller must supply history and focus already appropriate for the requested participant because the selector projection does not remove secrets from history.

`createLayaDecisions(config, transport)` provides the same two operations with independent `laya/systemone` identity. It targets the [Laya HTTP implementation](https://github.com/NandhaKishorM/laya/blob/6d942c92081fbc139e736bbd9ac0023223c29b7f/laya/serve.py) and records the protocol revision, actual response model and routing, validated probabilities, confidence fields and raw JSON digest. Choose `english`, `multilingual`, `typed-decisions` or explicit `auto`; arbitrary model names are refused locally. Explicit checkpoint requests require matching returned routing. Automatic requests use the upstream bundle identifier and retain the actual selected checkpoint. `low_confidence: true` always yields an undetermined judgment or rejects a candidate without expansion, even with a high `noul`. Entropy `confidence` is not treated as calibrated `answer_confidence`.

Laya requires explicit `max_questions` (at most 64), `max_state_chars` (at most 50,000 compact-JSON Unicode code points), `max_request_bytes` (at most 2 MiB), `max_response_bytes`, `max_len`, `head_max_len` (both at most 8192) and `min_confidence`, in addition to the shared probability and operation limits. Window/confidence controls are sent and recorded on every request. The server can impose tighter limits and counts serialized state differently. The HTTP endpoint performs single-window inference: these limits and the SDK estimate counter do not prove that its tokenizer covered every description or history message. Local question/state/body limits produce recorded skip/undetermined results without dropping questions or sending unrecorded batches. Transport requires HTTPS except explicitly enabled loopback HTTP; `apiKey: null` explicitly selects an unauthenticated deployment. Response byte limits, cancellation and timeout include body delivery, and cleanup cannot delay an aborted operation.

`makeDecisionRecord` captures complete sanitized requests, validated typed results, public config, adapter identity and SDK input digests. Both adapters also store the raw JSON response digest when available; malformed non-JSON responses retain their failure status. The config contains the requested model; successful responses retain their actual model identity. Selector evidence binds the final Plan digest and its selector/config/input. Director evidence also binds the ordered actions and assessments. Judge evidence binds the command-before input with discovery disabled and the supplied provider judgments, including their target, path and provider. Multiple judge records may cover separate results, but duplicates and uncovered provider results are rejected. Every non-fixed/non-none Plan requires selector evidence, and every judgment outside the fixed/manual providers requires matching judge evidence. Fixed/manual decisions remain explicit author inputs. These records are command metadata and are never inserted into model messages.

Replay format version 2 adds complete Plans and evidence. It does not accept version 1 exercise data. Transport headers, credential fields and raw base URLs are rejected recursively in recorded structured data. This is not text redaction: an author's description or history may itself contain sensitive text. Logs remain private exercise data. Hashes verify replay consistency, not whether a provider's probabilities are well calibrated or a remote answer is true.

<a id="verification"></a>
## Verification

Run from the Harness root after installing the locked tarballs:

```sh
pnpm run test:roleplay
```

The Jev request snapshot is `tests/jev.test.ts.snapshot`; protocol tests use an injected fake fetch, including timeouts during response-body delivery. Laya tests are in `tests/laya.test.ts` and exercise the fixed upstream wire vocabulary through injected responses and an actual local HTTP server. They do not run upstream inference or load weights. No real model request was executed for these checks.

The owner-local tests use Node's test runner with `tsx/esm`, which also works across the repository's supported Node versions. They are not applications or a new executable entrypoint. The tests assert that char.pub resolves to installed `dist/index.js` exports rather than cross-repository source paths; the root consumer smoke separately exercises emitted JavaScript.

<a id="understand-the-implementation"></a>
## Understand the implementation

The input is parsed with the installed char.pub SDK schemas. Origin fields identify build inputs; this offline library does not verify Registry permissions, draft expiry or signed download authority. Source text is supplied explicitly and verified against its asset digest. Trace retains the root identity and semantic digest. `startSession` supplies the opening exactly once; `confirm`, `enterScene`, `setPresent` and `toTurnStory` own state semantics. `createPreparationCatalog`, `fixedSelection` and `prepareContext` own selection and final messages. No content schema, condition evaluator or prompt assembler is copied here. The standalone append API replays the existing log before constructing one detached entry. `ReplayCursor.from(log)` verifies external data once and exposes frozen `log` and `current` values; its `append` and `preparation` methods advance from that immutable state without retaining every reconstructed step. The durable runtime uses this cursor while folding events, with no mutable session cache to reconcile.

No runtime invariant companion is published because this library has no registry or shared runtime observations that can diverge. Its replay comparisons and owner-local tests check the returned exercise data.

<a id="model-experience"></a>
## Model Experience

### Prepared message output

#### What the model sees

`createReplay` and `replay` send no requests. When explicitly invoked, Jev or Laya sees only the selected view’s history/focus and candidate directory descriptions and their visible metadata, or the exact authored judge questions; it does not receive artifacts, state variables, bindings, overlays or candidate bodies. The replay result exposes the actual SDK-prepared messages for the caller's selected participant, opening, history, Story state, source references and locked policy. Exercise input contains the complete artifact and supplied source texts; callers must not forward the log or complete input to a participant model.

#### Token effect

The SDK estimates and enforces the explicit profile's context and output-reserve budgets. Decision requests additionally use the explicit directory budget, whole-request budget and request count limit. Fixed selections expose only admitted source bodies in prepared messages. The log's hashes and command metadata are not added to model context.

#### KV Cache effect

The library creates no provider cache. A command may change earlier prepared content, order or participant projection; callers must compare actual messages before assuming a reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Initial opening judgments currently accept only fixed/manual providers because there is no model-opening receipt input. Automated judgments are recorded on later commands.
- Offline replay accepts only the `estimate` tokenizer. Exact tokenizer identities require a later asynchronous loader and corresponding replay metadata.
- This is an in-memory offline exercise format, not durable Harness Session history. Persistence, crash recovery, concurrent writers, Session forking and SessionEventMap integration are absent.
- There is no roleplay profile, agent-loop integration, tool execution or generation-model call. Jev protocol tests use fake HTTP responses; Laya additionally uses real loopback HTTP with a router-response substitute. No live inference endpoint, model weights or decision-quality evaluation is implied. Prepared messages are the only rendered output here; they are not injected into upstream history or system-prompt services.
- Sources must be supplied locally; Registry authorization, asset downloading and OAuth are outside the library. Supplied bodies used by assembly are verified by the SDK.
- The caller provides capability support and any degradation explanation. An explanation is not proof that an external runtime implements that behavior.
- Every append replays the entire log. Untrusted oversized logs need application-level size and command-count limits before parsing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
