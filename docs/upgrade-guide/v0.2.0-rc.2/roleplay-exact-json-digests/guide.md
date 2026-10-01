---
kind: upgrade-guide
description: Roleplay replay and Session verification now reject changes to exact runtime text that older normalized digests could overlook.
---

# Exact roleplay record digests

English | [中文](guide.zh.md)

## Change

The experimental char.pub replay and roleplay runtime now bind exact JSON strings and dictionary keys in commands, turns, prepared messages, decision receipts and Session projections. Unicode normalization, line endings and trailing spaces are significant. Source asset hashes retain their existing byte validation; authored content canonicalization is unchanged.

Older records created from canonical text remain compatible. A record containing noncanonical runtime text may now fail verification even without subsequent editing, because its stored digest used the older normalization algorithm. Verification does not fall back to that algorithm or rewrite recorded heads. Event shapes and Session generations have not changed.

## Migration

1. Back up existing roleplay Replay JSON and Session JSONL files before upgrading. Keep their original bytes and the SDK snapshot identified by their recorded manifest; retained snapshots are documented in [the SDK vendor directory](../../../../third_party/charpub/README.md).
2. Run the existing consumer's replay or Session inspection against a copy. Successful verification permits normal use. An exact-digest mismatch requires review; it does not authorize modifying the log or recalculating its hashes.
3. If review requires the old behavior, use the matching earlier checkout and retained SDK snapshot in isolation, without model calls or continued writes to the old log. Start a new Session explicitly when continuing with the updated runtime; do not present it as an automatic migration of old state.
4. Confirm the original files remain byte-identical. The runtime tests cover three retained historical Session samples and explicitly reject a preserved older raw-text Replay without rewriting it.
