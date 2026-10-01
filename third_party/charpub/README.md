---
description: "Immutable char.pub package tarballs, active selection and refresh procedure for Harness consumers."
---

# char.pub SDK snapshot

English | [中文](README.zh.md)

## Summary

This directory retains compiled char.pub package snapshots for Harness consumers. Each snapshot has exact byte hashes, and current.json selects the active set. Retained snapshots are never overwritten.

## Table of Contents

- [Snapshot identity](#snapshot-identity)
- [Refresh](#refresh)
- [Dev Note](#dev-note)

-----

<a id="snapshot-identity"></a>
## Snapshot identity

These Apache-2.0 package tarballs are local build snapshots of char.pub. They are external package artifacts, outside the MIT Cordis source copies in `vendor/`. Each `manifest.json` records exact byte digests, package versions and source revision. `current.json` selects the active snapshot and pins its manifest digest. The original root snapshot and previous `snapshots/` directories retain their bytes. `source_dirty: true` means the snapshot includes uncommitted development changes; the revision alone cannot reproduce those bytes. The tarball hashes identify the inputs used by this checkout.

`@char-pub/core`, `@char-pub/assembler` and `@char-pub/contracts` expose compiled ESM and TypeScript declarations. Harness consumers import package names. Root pnpm overrides pin transitive imports to the same tarballs. No char.pub source directory, schema copy, source condition or absolute repository path is required.

<a id="refresh"></a>
## Refresh

In the char.pub checkout, run `node scripts/pack-runtime-sdk.mjs <new-output-directory>`. Create a new `snapshots/<id>/` directory, copy the three tarballs into its `tarballs/` subdirectory and copy the manifest alongside that subdirectory, retaining the Apache license. Update `current.json`, both roleplay package dependencies and root pnpm overrides to the new directory. Run `node scripts/verify-charpub-sdk.mjs`, update the pnpm lockfile and run `pnpm run test:roleplay` and `pnpm run test:roleplay-runtime`. The verifier checks every retained snapshot and requires direct and transitive dependency paths to select the active bytes. Capture representative old replay and Session files before changing the installed SDK; report their recovery result separately from new-session tests. Never overwrite a retained snapshot or rewrite a Session generation to make its recorded digests match a newer SDK.

This snapshot has not been published to npm. It is not an upstream DeepSeek dependency or an assurance of online Runtime compatibility. Online model calls, OAuth, and the upstream session-loop composition have separate acceptance checks.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
