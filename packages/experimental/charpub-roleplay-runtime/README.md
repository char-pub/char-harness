---
description: "Durable roleplay requests and committed Story state using the Harness Session and LLM services."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-charpub-roleplay-runtime

English | [中文](README.zh.md)

Runtime records use exact JSON digests for original text, including Unicode form, line endings and trailing spaces. Older normalized receipts are never silently rewritten or accepted by fallback; see the [upgrade guide](../../../docs/upgrade-guide/v0.2.0-rc.2/roleplay-exact-json-digests/guide.md).


## Summary

`ctx.roleplayRuntime` owns text generation over fixed char.pub artifacts. It consumes the packed SDK through the [replay library](../charpub-roleplay/README.md), stores required Session events through the existing persistence service and dispatches the exact recorded request through `ctx.llm`. Its composition omits the coding agent loop, system-prompt service and tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Service](#service)
- [Registry access](#registry-access)
- [Storage and recovery](#storage-and-recovery)
- [Configuration and verification](#configuration-and-verification)
- [Optional local browser entry](#optional-local-browser-entry)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The private bundle declares its layer in [cordis.patch.yml](cordis.patch.yml). The [profile reference](PROFILE.md) owns the explicit configuration and verified named-profile composition. No default profile includes this layer; a generation provider and caller are supplied separately.

<a id="service"></a>
## Service

`create(id, input, signal?)` validates an opening and persists it before returning its reconstructed state. An existing ID is never overwritten. Cancellation can reject before storage creation starts; once a header is acquired, initialization completes its opening so a late cancellation cannot strand a header-only session.

`submit(id, command, callConfig, signal?)` accepts an evidenced or fixed Story command and an explicit provider, model and positive `maxTokens` within the artifact consumer profile's reserved output budget. It first resolves the provider's actual configuration. A smaller advertised model context window rejects the mismatched profile. Text-only prepared messages are required; attachments are rejected.

The requested event is flushed before dispatch. The driver sends only `requestMessages(requested)`, preserving SDK role, order and text without another history or prompt assembly. Success requires one terminal stop at the end of the stream, nonempty text and no tool or media content. Reasoning remains in the recorded attempt and is not appended to the shared conversation. Successful settlement contains the complete committed Story state, turn and assistant response; failed or cancelled attempts do not advance Story facts.

An exact repeated command ID and original call configuration returns its recorded outcome without calling the model again. Changed reuse rejects. Concurrent operations on one Session reject as busy. On reopening, an unanswered request is settled as interrupted before another command is considered; it is never automatically dispatched again. Already stopped Stories allow inspection but reject new generation; the request that causes the ending may finish its last reply.

`inspect(id)` reconstructs current committed state and pending requests from explicit asynchronous storage reads. The service retains no independently writable Story cache. Disposal cancels active operations and waits for their storage handles to close.

<a id="registry-access"></a>
## Registry access

`createRegistryClient` discovers a same-origin OAuth issuer with `oauth4webapi`. Supply the Registry origin, issuer, manually registered public client ID, exact callback URI, requested scopes and positive HTTP byte/time limits. `beginAuthorization` returns the browser navigation URL; `completeAuthorization` validates one-time state, callback URI and S256 exchange. `refreshAuthorization` rotates credentials with a single in-flight refresh. Revocation is ordered after a pending refresh. Failed or uncertain refresh exchanges clear credentials and are never retried. Tokens and PKCE state remain in private process memory; disposal aborts and settles in-flight HTTP work before forgetting them, without claiming remote revocation. No credential is returned with an artifact or written to Session events.

`release(exact)` validates the exact published root against its ID-based receipt and checks downloaded artifact bytes. `receipt(buildID)` exposes draft-build state; `draftBuild(buildID)` requires a ready, unexpired receipt and matching complete draft origin. Artifact download redirects use credential-free requests, with protocol, redirect-count, total-body-size and response-deadline checks. HTTP is allowed only for explicitly configured loopback development endpoints. Reads require current Registry authorization; a returned artifact is an acquired snapshot, not a promise that future network reads remain authorized.

`releaseSource(exact, signal?)` first validates the exact released artifact, then reads its immutable author definition at the receipt's current address and fixed label. It checks the canonical source digest, original ref and creation ID against that verified release, and returns `{ release, source }` with canonical `source.creation` and the Registry's `source.revision`. The source digest does not cryptographically bind the Revision ID: that mapping comes from the authenticated Registry response. Cancellation returns no partial result, and missing, denied or mismatched sources never fall back to the IR or latest version. This read does not inspect or upload a Runtime Session, create a proposal, or confirm contribution rights.

`sourceTexts(loaded, preparation, signal?)` calls the SDK loading manifest with the exact Plan, requests only its selected or required bodies and verifies source ID, asset ID, digest and UTF-8 bytes. Feed those verified bodies into the existing runtime input or SDK preparation. Release, draft receipt/artifact and Source reads accept an optional AbortSignal. Caller-supplied artifacts cannot substitute for a receipt validated by this client. `createWorkingDraft`, `derive` and `contribute` require explicit confirmation for each POST and never retry an uncertain mutation. They expose no publication or existing-draft editing operation. Confirmation records user intent in the calling application; the Registry independently checks OAuth scopes, rights and current resource permissions.

<a id="storage-and-recovery"></a>
### Local Ending proposals

`createEndingProposals({ registry, inspect })` binds the existing client and authoritative Session reader once. `prepare({ session, ending, title, description?, rights_ack }, signal?)` reads a committed published Scenario and its exact Registry source. The caller supplies an explicit Ending object written by a person or an external model; preparation neither invokes a model nor treats its output as confirmation. It uses Core object canonicalization, composition digests, three-way merge and static checks to add a new Ending and update only the Endings order. Existing Ending IDs, pending requests and local/draft roots are refused.

The returned candidate contains the current target address, original exact source and Revision, source-version root rating/license/content warnings, complete Ending, complete intended request, local Session/head/state digest and authorization version. The caller must retain the acquired artifact's aggregate rating gate (`release.artifact.meta.rating`); root `source_rating` cannot replace it. The source-version metadata is not the target's current draft policy; the Registry rechecks current rights and permissions. Show the complete request and metadata to the user. After their separate review action, call `submit(candidate, { candidate_digest: candidate.digest, rights_ack }, signal?)` with the same explicit grant. Copies, edits, mismatched confirmations and a changed committed head or authorization version are refused. The Session is rechecked before dispatch preparation; later play is not locked during token refresh or HTTP, and cannot change the reviewed historical snapshot.

Only the request's allowlisted contribution fields are posted, with `agent: true`; Session identifiers, hashes, history, loaded Source text, streams and credentials are not included. The same grant is rechecked after acquiring its token, immediately before POST; same-grant refresh preserves the authorization version, while login, revocation or credential loss invalidates it. An already cancelled submission makes no request. Once a candidate is attempted it stays consumed in this process, even on cancellation or failure. Explicit HTTP 4xx rejection is reported as such; uncertain transport, cancelled dispatch or invalid responses report `roleplay_proposal.outcome_unknown`. Reconcile the Registry result rather than blindly preparing and retrying. No persistent cross-process idempotency, automatic proposal UI, full chat-to-story conversion, acceptance or publication is supplied.

### New sequels from a reviewed situation

`createStoryContinuations({ registry, inspect })` captures the authenticated client and committed Session reader. `prepare({ session, namespace, name, display_name, opening, agent, rights_ack }, signal?)` requires a published Scenario, an explicit new opening and a declared agent contribution. It reads the exact Registry author source and validates the committed state against that definition. The returned review shows the new work address, exact source and Revision, source and aggregate content warnings/rating, license, complete request and reset progress. Preparation performs reads only; the Registry assigns the new work identity.

The request carries only the current scene, present cast, complete variables and knowledge, and the caller's opening as `from_play`, alongside the exact source and ordinary sequel fields. The Registry turns those fields into a new static opening, preserves background and scoped references, and removes old executable plot, scene goals, entry knowledge and start effects. Previous progress and dialogue are not copied. The review explicitly resets visited scenes to the opening and clears reached/ended/happened with stopped=false. This creates a new story; it does not resume the old plot or support state-preserving Remix.

Show the whole review, including potentially private variable/knowledge values and opening text, then separately call `submit(review, { candidate_digest: review.digest, rights_ack }, signal?)`. The factory rechecks the original review instance, exact bytes, committed head/state and authorization version, using the same confirmation and one-attempt rules as Ending proposals. It captures the confirmed historical situation before dispatch preparation; subsequent play is not locked and cannot change that request. Cancellation before submission makes no request; after an attempt, uncertain outcomes report `roleplay_continuation.outcome_unknown` and consume the review. Reconcile the result before preparing another request.

Success creates only a new private draft in the user's own namespace. The Registry checks current source access, adaptation rights and asset grants; OAuth cannot edit the resulting draft or publish it through this client. `agent: false` never clears an existing source agent marker, and OAuth alone does not imply agent authorship. Session identifiers, history, Source bodies and credentials are excluded from the request. No Session event, model call, automatic summary or publication occurs.

### Synthetic preview export

`createRuntimePreviewExports({ inspect })` reads committed Story state through the caller's captured Session inspector. `prepare({ session, history, bindings, for_participant?, story_guidance? }, signal?)` requires explicit synthetic history and role bindings; it never fills them from private runtime messages or character descriptions. A per-agent profile requires an explicitly selected viewpoint. The shared SDK validator checks the exact source artifact, effective Preset, resolved locale, tokenizer version, Story state, bindings, speakers and the 1 MiB payload limit. Release, Registry draft-build and local-build roots keep their real identities; expired draft sources are refused.

Review the entire `payload`, including variables and knowledge state, before separately calling `export(review, { candidate_digest: review.digest }, signal?)`. The factory rejects copied or modified reviews, pending requests, and changed committed heads or states. It returns `{ payload, json }` without network calls, downloads or file writes; repeat confirmation of an unchanged snapshot produces the same bytes. Already-cancelled calls do not inspect a Session. Cancellation after a read cannot undo that read, but does not return a file or write anything. The file excludes local review/session identifiers, confirmation digests, OAuth state, Source bodies, selection Plans and runtime overlays. It contains only the shared handoff fields and the explicitly supplied synthetic history and bindings.

Exported state can itself contain private information. The caller must show it in full, retain the artifact's aggregate rating gate and let the user choose where to save or share it. A digest detects changes; it does not authenticate the sender or grant the receiver access to the work or its assets. Web import must independently review and validate the file against its chosen artifact. Applying it to a newer draft is a separate explicit operation, not identity-preserving replay. Saving a successful preview as an author test is another confirmation and may retain separately acquired full Source text; this exporter does neither operation.

## Storage and recovery

`roleplay/opened` contains the fixed SDK input once. `roleplay/requested` contains the command, proposed and resolved call configurations, original prepared messages and verified state/Plan/request digests. `roleplay/settled` binds the request and retains its compact model stream, usage and outcome. Pure replay rechecks all of them. These required events are registered in the generated persistence vocabulary; readers that do not recognize them refuse the log. The [persistence change record](../../../docs/persistence-changes/2026-09-30-charpub-roleplay-events.md) describes compatibility. The [client-origin addition](../../../docs/persistence-changes/2026-10-01-charpub-client-origin.md) preserves optional external client IDs in fixed artifact contributor metadata; these labels do not authenticate a Registry request. [Previous-SDK recovery samples](tests/fixtures/pre-registry-sdk/README.md) retain original bytes and exercise interrupted pending requests without dispatch.

Append and flush are a commit interval. Once writing starts, cancellation cannot promise rollback. A storage failure can leave a request or successful settlement on disk; the operation rejects and the caller must inspect or retry the same command ID to reconcile the stored outcome. The driver never turns a storage error into an automatic second model call. JSONL's existing write ownership excludes other processes.

The Session log is the only durable record. `ReplayLog` values returned by projection are temporary reconstructed values. These logs contain artifacts, source bodies and private decision evidence and must not be sent wholesale to a participant model.

<a id="configuration-and-verification"></a>
## Configuration and verification

`timeout_ms`, `max_event_bytes` and `max_stream_bytes` are required configuration fields. The timeout covers the active operation; commit/close finishes uncancellably once a write starts. Each complete stored event is bounded, and streamed chunk JSON bytes are counted before retention. Excess output fails the attempt without committing proposed facts.

Tests boot real Session, JSONL, LLM and runtime rows through Loader, with an explicit network-free model adapter. They exercise message equality, viewpoint changes, close/reopen, idempotency, cancellation, disposal, interrupted requests and storage-barrier reconciliation. The pure projection tests also reject tampered fields and malformed successful streams. These checks do not call a live model.

No runtime invariant companion is published because each request and settlement is validated against one reconstructed log before dispatch or return, with no independently maintained request or Story cache to compare.

The independent Registry browser test uses a test-only IPC bridge, not an application launcher. Build the runtime package first, then compile the bridge with `node node_modules/typescript/lib/tsc.js -p packages/experimental/charpub-roleplay-runtime/tests/registry/tsconfig.fullstack.json`. The char.pub checkout selects this independent checkout through `E2E_HARNESS_ROOT` when running its `fullstack-harness` test; the bridge imports compiled package exports and keeps OAuth callback codes and tokens inside its process.

<a id="optional-local-browser-entry"></a>
## Optional local browser entry

The [roleplay profile guide](PROFILE.md) describes the opt-in `./app` plugin and `app.patch.yml`. Launch it through `dsh --profile roleplay`; the base bundle alone still has no frontend. The loopback welcome page links to the configured Registry to choose a work; its manual JSON entrance is advanced. The page reviews an exact Registry launch, authorizes independently, then creates a new durable Session after the user selects an opening, viewpoint and runtime character bindings. Registry, OAuth redirect and model routes come only from local profile configuration. A launch cannot replace them or carry credentials or dialogue.

The page supports Story content and the estimate tokenizer. It uses the configured generation adapter, required/direct context and `noneSelection`; it does not run Jev/Laya, infer Story actions or decide opening judgments. New builds require a new-session confirmation. Old tabs retain an opaque local handle and cannot send into a subsequently created Session. Private and public outward character descriptions are separate fields.

The supplied DeepSeek profile declares `multiple_system_messages: false`. The SDK merges adjacent system regions before recording a request, preserving their complete text in the adapter's effective system prompt. With this profile, a Preset that separates system messages with conversation history is incompatible. Existing Sessions and artifact-locked profiles retain their own capabilities; a changed local profile applies to new Sessions without an artifact-locked profile.

The page is a compiled React client served by the same profile-owned HTTP plugin. Its primary view presents dialogue, visible characters and the current scene; Registry/model status and technical JSON are secondary. The browser receives player DTOs, not the raw Story knowledge/variable tables, Source bodies or OAuth credentials. Character roles and goals use the same SDK view filter as context preparation.

Local records come from the existing Session persistence provider. Listing reads a bounded page of logs and reports unreadable records explicitly. Selecting a record rechecks its exact Registry source and current authorization before exposing a fresh operation handle; expired draft builds and inaccessible sources fail without changing the log or substituting the latest version. Record identifiers are stable opaque hashes for local UI drafts; active handles remain process-local, and neither identifier grants Registry access. Refreshing the page can retrieve the current committed snapshot without creating another Session.

Each submitted reply carries one client request ID. Concurrent identical submissions share the operation, and completed retries recover the stored settlement; changing the reply under the same ID is rejected. After a lost response, inspect that same request before offering an explicit retry. Cancellation identifies both the Session handle and request, so an old cancellation cannot stop a newer reply. The UI shows actual sending and settled results; it does not simulate token streaming.

Resuming an interrupted request only reads the log. Normal sending stays blocked until the user explicitly chooses to end the unfinished request and send a new reply. The new request uses a fresh ID and `recover_interrupted: true`; the existing driver records the old request as interrupted and dispatches the new reply once. The old request ID never triggers another model call. Stopped stories remain readable and cannot continue generating.

Authorization status describes locally available grants, not a remote validity probe. Model status reports the configured provider/model and whether its key reference is configured, which source layer supplies it and whether it is writable. [app-settings.ts](src/app-settings.ts) serves the Settings pages from the same services as the DeepSeek Harness Web pages: `llm.listConfigurableProviders()` lists Models providers, `credentials.set/unset` stores keys (`$DSH_HOME/.credentials.yaml` with the local provider), `settings.describe/mutate` reads and writes live fields in the profile patch, and `readPluginInventory` lists Loader entries. Writes are fenced by the read revision; an entry owned by a command-line overlay is reported read-only, and a launching-environment key stays read-only. The app's own HTTP limits are not offered as a form. A configured key does not promise that the key or network is usable. Neither page loading, status checking nor a settings write calls an inference endpoint, and no response returns a credential value.

Preview export has its own empty synthetic binding form and explicit summary. It never pre-fills play bindings or copies the transcript. Editing synthetic fields invalidates the displayed file review; confirmation still checks the committed head and exact candidate digest. Source bodies and credentials are excluded. Host, Origin, request nonce, bytes and operation deadlines are checked; cancellation reaches Registry reads and model generation. Completed storage commits remain authoritative during cancellation.


<a id="model-experience"></a>
## Model Experience

### Recorded prepared messages

#### What the model sees

Exactly the SDK-prepared roles and text stored in the requested event. The driver adds no prompt text or coding tools. Source IDs and receipts remain in the private log. DSH requires model metadata on assistant-role messages, so the transport maps prepared history to the explicitly synthetic `char.pub` / `prepared-history` source; the original SDK source IDs and the actual newly resolved model route remain recorded separately.

#### Token effect

The SDK enforces its declared context and output-reserve budget. Appending a successful assistant reply updates history without preparing another request or reserving its output twice; a later command prepares a fresh Plan. `prepared_turn` identifies the input associated with the latest actual preparation.

#### KV Cache effect

A new viewpoint, Story state or selection can change earlier request text and ordering. No cache reuse guarantee is made. There is no duplicate generic Session surface inserted into the request.


## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This is a separate driver, not an `AgentRegistry` implementation. Default Web/SDK transcripts, coding-loop resume and general Agent tooling do not interpret its requests.
- Conversation history is shared scene dialogue. Switching participants filters controlled setting material, not earlier speech by audience; private conversations need an explicit audience projection before this path can support them.
- Prepared assistant history has synthetic transport metadata, so original provider replay state is not preserved. Actual new generation configuration and streams remain recorded.
- Automatic action inference and model-opening receipts remain caller work. Jev judgments/selection can be supplied through the evidenced command API; the driver does not infer a Story action from free text.
- The Registry client keeps credentials only in process memory. Durable credential-vault integration, multi-process refresh coordination, live model quality and advanced game automation remain separate work. Source bodies acquired for a fixed Session remain private retained input; this client does not retroactively erase them after server-side revocation.
- The prototype reconstructs history for every operation. Large-session checkpointing and archival paging remain unimplemented; event and stream byte limits do not bound total session length.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
