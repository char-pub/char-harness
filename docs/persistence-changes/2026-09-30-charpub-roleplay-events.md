---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-30-charpub-roleplay-events

English | [中文](2026-09-30-charpub-roleplay-events.zh.md)

## Summary

Adds required roleplay opened, requested and settled Session events for the isolated char.pub driver; fixed SDK inputs retain Release, draft-build or local-build identities.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-charpub-roleplay-events
baseline: false
changes:
  - root: "event:roleplay/opened"
    previous: null
    after: "c5ad4768406d57113cb822813dc4192171c95e7bec94588b2d3d1a664a90a535"
    decision: same-version
  - root: "event:roleplay/requested"
    previous: null
    after: "9323ce58defdcb51a7e6e54e647763c7cc3ab7c8cef41d783dda9491fabcf416"
    decision: same-version
  - root: "event:roleplay/settled"
    previous: null
    after: "3aaa77ff2f8c9328943a9090210c47a82accab8cfd2c8559fcb33bf602ccf8a2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session records remain valid. Readers that do not know these event names refuse roleplay logs; the events are not ignorable. Opened fixes the packed SDK input, requested records an uncommitted command and exact model input, and only successful settled commits complete Story state and assistant history. The unaccepted experimental declaration includes the current SDK artifact union. No accepted persistence record or committed Session generation is replaced. A fixed old-SDK Replay and real JSONL sample recover with the new SDK; this sample does not establish compatibility for all previous artifacts. Synthetic prepared-history metadata does not claim the original assistant model identity.

<a id="verification"></a>
## Verification

pnpm run test:roleplay-runtime: 21 passed, including real Loader profiles, JSONL close/reopen, fixed old-SDK history, pending-request interruption without redispatch, message equality, cancellation, storage failure reconciliation and command/config idempotency. Old fixture digests remain unchanged. No live model call or default Web/SDK integration is claimed.

<a id="dev-note"></a>
## Dev Note

None.
