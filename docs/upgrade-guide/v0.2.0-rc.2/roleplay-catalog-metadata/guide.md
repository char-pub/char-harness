---
kind: upgrade-guide
description: Roleplay Selector directories expose additional visible metadata, which can change request budgets and recorded Plan verification.
---

# Roleplay Selector directory metadata

English | [中文](guide.zh.md)

## Change

The packed char.pub SDK includes declared perspective, keyword/semantic activation hints and resolved visible `about` identities in candidate directories. Older directories omitted these fields. Jev receives the additional metadata only when that node is exposed. Hidden target identities and candidate bodies remain excluded, and an association never selects or activates its target.

The directory and whole-request budgets include these fields. A previously fitting request can exceed its limit; Catalog, Plan, decision evidence or author diagnostic comparisons can change. Existing records that depended on the old projection may fail verification. The retained historical samples still verify, which does not guarantee compatibility for every recording. No Session event shape or storage generation changes.

## Migration

1. Keep original Replay JSON, Session JSONL and their SDK snapshot manifests unchanged. Back them up before upgrading; retained SDK snapshots are in [the vendor directory](../../../../third_party/charpub/README.md).
2. Recheck live request limits and inspect the actual Selector directory. Increase a limit only through an explicit configuration decision; do not remove the new metadata or skip budget validation to force an old request through.
3. Verify stored exercises and Sessions against copies. If verification fails, retain the original record and matching SDK for isolated inspection. Do not recalculate old heads, rewrite old Plans or relabel previous provider evidence. Start a new Session explicitly when continuing with the new behavior.
4. Review model-visible request snapshots before updating them. Run `pnpm run test:roleplay` and `pnpm run test:roleplay-runtime`; check that historical fixture hashes and pending recovery behavior remain unchanged. These local tests do not evaluate live-model selection quality.
