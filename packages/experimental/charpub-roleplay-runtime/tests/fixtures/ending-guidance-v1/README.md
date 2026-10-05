---
description: "Frozen JSONL evidence for ending proposals recorded before versioned narration guidance."
---

# Unversioned ending guidance

English | [中文](README.zh.md)

This fixture was captured before adding the optional guidance version. A real Loader and JSONL runtime with the keyless test provider recorded one ending proposal, explicit confirmation and rewind. The pending proposal and both narration requests therefore retain the original instruction bytes; no private play log or live model output is included.

The [manifest](manifest.json) pins the Session bytes, logical head, durable revision, pending proposal, request digests and prepared messages. [The ending tests](../../ending-confirmation.test.ts) pin that manifest, inspect a temporary JSONL copy without dispatch, compare every retained request and replay the old logical log. Neither inspection nor the test rewrites the fixture. Keep these bytes frozen; new guidance versions need separate captures.
