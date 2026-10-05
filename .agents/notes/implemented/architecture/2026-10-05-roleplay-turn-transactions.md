# Agent Note: Roleplay turn transactions

Status: implemented

English | [中文](2026-10-05-roleplay-turn-transactions.zh.md)

## Problem

A player utterance can imply several authored Story actions. Confirming an action before the new utterance reaches its judge loses the evidence for that action; committing actions before narration can leave facts changed after a failed reply. Reusing a logical head after undo also lets an old tab mistake a different event history for the state it observed.

## Decision

The [runtime](../../../../packages/experimental/charpub-roleplay-runtime/README.md) records intent, each decision input and its outcome before preparing one atomic Replay turn. The configured model proposes only authored target IDs and typed judgments. Core owns conditions and effects; narration success publishes the input, validated actions and assistant response together. Ambiguous decisions remain unconfirmed. Decision reasoning stays in private stream evidence, while the application projects player-visible progress separately.

The durable revision hashes the complete event prefix independently of the logical Replay head. Rewind appends a fact that restores a prior successful turn's logical state while retaining old requests and outcomes. Superseded IDs remain consumed. An unfinished attempt is ended only by an explicitly requested recovery with a new ID; it is never automatically dispatched again.

Ending eligibility is separate from authority to end play. The director can retain one state-bound proposal, but only a fresh explicit confirmation applies its recorded ending. Both proposal and confirmation remain atomic with narration; a failure preserves the earlier proposal and state. Public proposal fields follow the authored reveal policy, and the private record keeps the original decision provider. Confirmation reuses those values under a manual identity without asking the director or selector again. Undo restores the preceding proposal as part of the same recorded logical state.

Atomic narration uses a separate required `roleplay/turn-requested` event. The older `roleplay/requested` command/evidence types stay fixed. This preserves accepted Session types and lets older readers refuse new facts instead of silently interpreting a wider command union. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.0-rc.2/roleplay-player-turns/guide.md) owns operational migration.

An immutable ReplayCursor verifies an external log once and then advances its frozen current preparation. Runtime projection remembers cursors only through weak associations with the immutable Replay logs it created. External mutable logs never become cache keys. This removes repeated full Replay reconstruction within a Session fold without trusting caller-edited state or retaining every reconstructed step output. Each new Session read still validates the durable events; there is no independent persistent state cache.

## Alternatives considered

**Commit inferred effects before generation.** A rejected or interrupted reply would leave actions and visible dialogue out of sync. Keeping them prospective makes one successful settlement the publication boundary.

**Automatically apply eligible endings.** Even well-formed model judgments can mistake a question or tentative action for a terminal commitment. An explicit confirmation places this irreversible-in-story choice with the player while retaining automatic ordinary progress. Increasing the decision reasoning allowance can improve completion of structured answers, but costs latency and tokens and does not remove semantic mistakes.

**Use only the logical head for concurrency and idempotency.** Undo can return to an earlier head. A revision covering failed attempts and rewinds fences stale operations even when logical state repeats.

**Widen the legacy requested payload.** The persistence classifier correctly requires a global writer-version transition for its unversioned command union. A new required event limits compatibility change to the opt-in roleplay feature.

**Raise timeouts or cache whole mutable Replay results.** Thirty synthetic turns exposed repeated canonicalization, hashing and schema parsing, with the original path timing out at turn 14. Frozen cursors remove that repeated work; increasing deadlines would retain it, while mutable-result caching could hide edits and retain every expanded step.

**Invalidate every judgment after one stray leaf.** A provider can correctly judge an authored question while also returning a structural condition path. Only declared target/path pairs become Core evidence; an undeclared entry is ignored, and duplicates abstain only for their own leaf. This preserves independent valid evidence without interpreting unknown judgments or weakening confidence.

## Consequences

Intent recognition remains fallible; confidence values are model reports, not calibrated truth. Core rejects unavailable targets, and rewind offers correction after a settled turn. The private Session contains decision inputs, streams, original text and all branches. Deletion, pruning, cross-process checkpointing and large-history paging remain separate work.

Owner tests compare cursor results to full Replay, preserve historical fixture bytes, exercise all five write barriers, and verify multi-action failure, cancellation, recovery and stale revisions through real Loader and JSONL services. The fixed thirty-turn source-loader diagnostic completed with 60 local model dispatches after the cursor change; its wall times exclude live network/model latency and do not establish browser or production capacity. Message snapshots retain the same prepared content. The tests and log replay, rather than a parallel mutable invariant cache, own these checks.

Real JSONL checks also cover pending endings, restart, hidden/on-reach disclosure, stale proposal IDs, failed and interrupted confirmation, duplicate request recovery, rewind and automatic historical ending replay. Official adapter HTTP fixtures inspect the actual profile overlay with independent model routing, low decision reasoning and disabled narration reasoning. These deterministic checks establish runtime behavior, not live model quality.
