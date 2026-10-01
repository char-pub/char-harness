---
description: "Fixed old SDK Replay and JSONL bytes for scoped history recovery checks."
---

# Old SDK read compatibility fixture

English | [中文](README.zh.md)

## Summary

The fixed files preserve one old-SDK Replay and real JSONL Session for compatibility checks. Recovery tests use temporary copies and never rewrite the recorded input. Successful recovery covers this sample only.

## Table of Contents

- [Stored evidence](#stored-evidence)
- [Capture method](#capture-method)
- [Verification](#verification)
- [Dev Note](#dev-note)

-----

<a id="stored-evidence"></a>
## Stored evidence

These bytes were captured before replacing the original packed char.pub SDK. `manifest.json` includes the exact old package hashes, file hashes and expected committed messages. The source revision and dirty build flag are recorded in the manifest; the commit alone cannot reproduce those bytes. This directory is immutable test evidence, not a live Session root. Never update its hashes to make a new SDK pass.

The capture used the real Cordis Loader, roleplay runtime and JSONL provider with the existing network-free test LLM adapter. Alice confirms one reward and selects the guide Source; Bob enters the garden, excluding Alice's private fact. Both responses settle successfully. A third request is appended and flushed through the real persistence handle without a settlement. `replay.json` contains the committed replay before that pending request; `session.v4.jsonl` contains the actual header and six durable events, with original timestamps and byte order.

The history test verifies file digests before replay, reads a temporary copy of the JSONL without rewriting it, then recovers the pending request as interrupted on that copy with zero model dispatch. It never opens the checked-in Session tree for writing. This is one representative old input, not a claim that all old artifacts remain compatible. A new SDK may explicitly reject unsupported history; preserve this evidence and document that boundary rather than rebuilding its artifact or changing its recorded Plan/head.

<a id="capture-method"></a>
## Capture method

The one-time generator requires the original installed tarball locators and exact original SDK manifest before creating any destination. It refuses the current snapshot installation and any existing destination. Under the original SDK installation, the command was:

```sh
node --import tsx/esm --input-type=module -e 'import { captureHistory } from "./packages/experimental/charpub-roleplay-runtime/tests/fixtures/capture-history.ts"; await captureHistory("packages/experimental/charpub-roleplay-runtime/tests/fixtures/legacy-sdk-280c696c")'
```

The command must not be rerun over this directory. Capturing another SDK needs a separately reviewed generator with its own installed-SDK check and a new destination; it is new evidence, not a replacement.

<a id="verification"></a>
## Verification

```sh
node --import tsx/esm --test packages/experimental/charpub-roleplay-runtime/tests/history.test.ts
```

The original installation passed both tests. Tests for the new SDK must separately report compatibility or the explicit rejection; fresh dynamic-fixture tests alone do not establish old-log compatibility.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
