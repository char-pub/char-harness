---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-05-roleplay-ending-guidance-version

English | [中文](2026-10-05-roleplay-ending-guidance-version.zh.md)

## Summary

Adds optional guidance_version: 2 to recorded ending proposals so new narration distinguishes structured confirmation from agreement in ordinary player text.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-05-roleplay-ending-guidance-version
baseline: false
changes:
  - root: "event:roleplay/turn-requested"
    previous: "2026-10-05-roleplay-player-turns"
    after: "4423cf724108d910961087ac89fd1b2005e09a1511750bd2158fcf145e135b96"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The optional field appears only inside the new turn operation and director binding. Missing guidance_version selects the original instruction bytes without adding a default or changing old proposal IDs, prepared messages, request digests or historical ending semantics. New proposals explicitly select version 2. Legacy requested and settled schemas and the Session writer version are unchanged.

<a id="verification"></a>
## Verification

A keyless JSONL fixture captured before this change retains an unversioned proposal, confirmation and rewind. Tests pin its manifest and bytes, read a temporary copy through real Loader services without writes or model dispatch, and compare its pending proposal, prepared messages, request digests, logical head and durable revision. New ordinary player text containing confirm/adopt/agree remains pending and receives the versioned instruction in the actual recorded narration messages; runtime and app snapshots cover that guidance.

<a id="dev-note"></a>
## Dev Note

None.
