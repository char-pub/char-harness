---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-roleplay-player-turns

English | [中文](2026-10-05-roleplay-player-turns.zh.md)

## Summary

Adds required events for durable player intent, bounded decision requests and outcomes, atomic turn narration, turn abort and append-only rewind. New turns optionally retain state-bound ending proposals and explicit confirmations; fixed artifact input gains optional authored player control.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-roleplay-player-turns
baseline: false
changes:
  - root: "event:roleplay/decision-requested"
    previous: null
    after: "6cae4ac270e7a3a906ea491be85cbc7ed65769ab4e19ba4b412635d1e0eca343"
    decision: same-version
  - root: "event:roleplay/decision-settled"
    previous: null
    after: "d16eee9f50096c74d9069b1ea1bbdc7702f966ce0ee22a01570d6053943893cf"
    decision: same-version
  - root: "event:roleplay/opened"
    previous: "2026-10-01-charpub-client-origin"
    after: "e224e23fc6488b4ec422884c3a1f6bd1ae9aee4f7e9a8ec0fd47b050ce7485b6"
    decision: same-version
  - root: "event:roleplay/rewound"
    previous: null
    after: "1ff8ac69735da91a644ea71fd33e39bfca274783bb71184a757e9863e314e588"
    decision: same-version
  - root: "event:roleplay/turn-aborted"
    previous: null
    after: "46e5038549e044a20354a7810275826471232daef93713194b159ce98b665c61"
    decision: same-version
  - root: "event:roleplay/turn-requested"
    previous: null
    after: "984d4f9a67c1ab8251e8c1605b4c32b2114d97059f1c49950e0d98df06f25fee"
    decision: same-version
  - root: "event:roleplay/turn-started"
    previous: null
    after: "92438df3901fe691f0cc84c57f3d0c65846d8defc2138310981f75529976031b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing requested and settled schemas retain their original commands and exact digests. Atomic turn commands use a separate required roleplay/turn-requested event, so older readers reject unfamiliar events. Ending proposal/confirmation fields are optional on the new turn operation and director binding, and confirm_ending is optional on the new player intent. Absent metadata adds no defaults and preserves recorded automatic-ending semantics. Story.player is optional on fixed content; legacy artifacts and messages retain their behavior. The Session writer version and existing JSONL files are unchanged. Rewind restores logical Story state and the preceding pending proposal while retaining events and consumed request IDs; revision covers every event, including failed attempts and rewinds.

<a id="verification"></a>
## Verification

Owner-local replay, provider, composition, projection, profile and immutable-history tests exercise durable turns, all five write barriers, stale revisions, explicit recovery, authored choice eligibility, current-input attribution and historical SDK bytes. Ending tests cover no effects before confirmation, hidden/on-reach disclosure, restart, failed and interrupted confirmation, duplicate recovery, ordinary-turn invalidation, rewind and automatic historical ending replay. Official DeepSeek-adapter HTTP fixtures inspect actual profile interpolation, independent model routing, low decision reasoning and disabled narration reasoning. Package TypeScript builds, strict NodeNext test checks and persistence freshness checks validate the resulting types. Tests use local model/HTTP fixtures and do not establish live-model quality.

<a id="dev-note"></a>
## Dev Note

None.
