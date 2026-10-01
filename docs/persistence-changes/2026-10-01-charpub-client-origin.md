---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-01-charpub-client-origin

English | [中文](2026-10-01-charpub-client-origin.zh.md)

## Summary

Preserves optional external client IDs on contributor records inside the fixed char.pub artifact stored by roleplay/opened.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-01-charpub-client-origin
baseline: false
changes:
  - root: "event:roleplay/opened"
    previous: "2026-09-30-charpub-roleplay-events"
    after: "c5069d032188c2d638fae7b35f54d85d6645aa3d63a73890425cb499bbccca81"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The optional client_id field extends the embedded artifact metadata and IR metadata without changing Session framing, existing required fields, requested events or settled events. Existing records without client IDs remain valid. The previous roleplay declaration and finalized Session generations remain unchanged.

<a id="verification"></a>
## Verification

The installed SDK passes immutable replay and real JSONL recovery for both retained historical samples, including pending interruption without model dispatch. The packed-SDK consumer builds client-attributed artifacts and checks client_id in both artifact metadata and IR metadata. Source fixture replay preserves exact BOM, CRLF, decomposed Unicode and trailing whitespace.

<a id="dev-note"></a>
## Dev Note

None.
