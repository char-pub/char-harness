---
description: "Immutable replay and JSONL evidence captured before the Source fixture and client-origin SDK refresh."
---

# Previous SDK recovery sample

English | [中文](README.zh.md)

## Summary

This sample preserves Replay and real Session JSONL bytes produced by the previously installed SDK. The manifest pins its package bytes, recorded messages and file digests. Tests never rebuild its artifact or overwrite the recorded Session.

## Table of Contents

- [Capture](#capture)
- [Recovery](#recovery)
- [Dev Note](#dev-note)

<a id="capture"></a>
## Capture

The retained [SDK manifest](../../../../../../third_party/charpub/snapshots/story-v1-bb93d2171b49cf91/manifest.json) identifies the installed inputs. Before changing dependencies, `captureSnapshotHistory` in [the capture helper](../capture-history.ts) verified the manifest digest and both installed package locators, then exclusively created this directory. The real Loader, JSONL provider and runtime recorded two synthetic text responses and one flushed unanswered request without network calls. The [fixture manifest](manifest.json) records the exact bytes; copying the older historical fixture is not a substitute for this capture.

A capture requires its named snapshot to be installed. A different installed snapshot fails before creating the destination. Every capture uses a new directory. The [earlier sample](../legacy-sdk-280c696c/README.md) remains independent evidence.

<a id="recovery"></a>
## Recovery

The [history tests](../../history.test.ts) verify the immutable manifest and file digests, reconstruct the recorded committed state and messages, and read JSONL through the real Loader. Pending recovery runs on a temporary copy, records interruption and dispatches no model call. Read-only recovery does not rewrite the copied committed generation; the original files stay unchanged throughout. Passing this sample does not establish compatibility for every historical artifact.

```sh
node --import tsx/esm --test packages/experimental/charpub-roleplay-runtime/tests/history.test.ts
```

<a id="dev-note"></a>
## Dev Note

None.
