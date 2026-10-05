---
kind: upgrade-guide
description: Roleplay player turns retain planning evidence and append-only rewind events that older runtimes must not ignore.
---

# Durable player turns

English | [中文](guide.zh.md)

## Change

The experimental roleplay runtime supports authored player control, constrained turn decisions and append-only rewind. New player turns store intent, exact decision requests and outcomes before narration. Required new events bind those attempts to the original logical head and durable event revision. The pure Replay operation adds one input with ordered Core-validated actions; narration success commits them together. Existing explicit commands and previously stored Sessions remain readable with their fixed SDK inputs.

The packed SDK includes the optional `Story.player` declaration and the required `story.player-control` capability on content using it. Runtime input then uses the SDK's exact participant identity. Legacy content without the declaration keeps its former user-message behavior. The declaration does not reassign old history or imply that the runtime `user` binding names a cast member.

New player turns retain eligible endings as state-bound proposals until explicit confirmation. Optional proposal/confirmation metadata belongs to the new turn events; existing commands and old turns without that metadata keep their recorded behavior and exact digests. A proposal survives restart, failed attempts and inspection; successful ordinary play replaces or clears it. Confirming skips further decisions, makes one narration request and commits terminal effects only on success.

## Migration

1. Back up Session files and retain their original SDK manifest before updating the runtime. Verify a copy with Session inspection; the runtime does not rewrite existing entries, hashes or opening inputs.
2. Configure explicit generation and decision routes with minimum confidence, action count, whole-turn decision call and token limits. Use `play` for player text/choices, preserving one client request ID and the latest `revision`. Existing `submit` consumers can continue issuing explicit commands.
3. Upgrade all readers before writing player turns. Older readers cannot interpret the new required events and must refuse them; do not mark them ignorable or remove them to make an old reader continue. Return to a backed-up pre-turn copy with its matching older runtime only as a separate history.
4. After interruption, inspect the original request. Reusing a completed ID returns its stored outcome; an unfinished ID never dispatches again. End it explicitly through a new ID with `recover_interrupted: true`. Do not infer rollback from a failed write or cancelled request.
5. Use `rewind` with the observed revision to restore the previous successful player turn. Rewind retains original events and idempotency records. Refresh the player view and operation handle; an old revision cannot create a new branch, and a superseded request ID cannot reapply its effects.

6. Render only the pending proposal’s public fields. Send `confirm_ending: { proposal_id }` with a fresh ID, confirmation text and the latest revision; never submit the private ending target or combine confirmation with a choice. Reconcile uncertain confirmation with the original ID. An undone confirmation restores its preceding proposal; refresh it before another confirmation.
