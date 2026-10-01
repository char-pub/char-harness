---
description: "Play exact char.pub story versions in a local browser, keep separate session drafts, and reconcile interrupted replies."
kind: "package-library"
---

# @deepseek-ai/dsh-charpub-roleplay-web

English | [中文](README.zh.md)

## Summary

Choose a char.pub story, review its exact version and opening, and take part through your local model. The player keeps local stories in a sidebar, the conversation in the center, and the current visible scene and characters beside it. It restores saved sessions and keeps an unsent reply for each record in this browser tab. The page uses the DeepSeek Harness layout, controls and Settings panel with the [char.pub brand](https://github.com/char-pub/brand-assets) palette and mark. The model and Registry credentials stay in the configured Harness profile.

## Table of Contents

- [Use this application](#use-this-application)
- [Recovery and privacy](#recovery-and-privacy)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-application"></a>
## Use this application

Start the configured named profile through the existing `dsh --profile` launcher. The [Runtime profile reference](../../packages/experimental/charpub-roleplay-runtime/PROFILE.md) owns setup, generation-provider configuration and the local address. This private package supplies static assets to that profile; it has no separate executable or profile plugin.

Open the profile's browser address and follow the char.pub link. In char.pub, select **Start playing** on a work or **Try draft** in the editor, and hand the exact version to this Runtime address. Authorize Registry access when requested, review the rating, license, opening and limitations, and fill the required roles before choosing **Enter the story**. Manual launch JSON remains available under **Advanced**.

Select a saved story to resume it. The sidebar shows each record's actual creation date and time; switching records keeps each unsent reply. Enter sends a reply, and Shift + Enter inserts a line break. **Settings** → **General** changes the interface language, appearance and story text size without changing the story's locale. **Models** lists each configurable provider with its key state; **Edit** opens its card for the API key and, under **Customized settings**, the API endpoint and model catalog. Keys go to the profile's local Harness credentials and endpoint or catalog changes to the profile's `cordis.patch.yml`; a key from the launching environment and an entry owned by a `--patch` overlay are shown as read-only. **Built-in plugins** lists the running plugins with their module and runtime state. **char.pub access** authorizes Registry reads. The sidebar **Plugins** page lists the same plugins; a plugin with live fields opens a generated settings form, and the model adapter opens **Models**. Narrow screens move the side panels into keyboard-accessible drawers.

<a id="recovery-and-privacy"></a>
## Recovery and privacy

When a request result is unknown, check its status before retrying. A confirmed missing request can be explicitly resent with the same ID and original text. A persisted interrupted request must first be reconciled, then explicitly ended before a new message is sent. Cancellation requests a stop; an already completed reply may still be saved. Closing a page does not promise to cancel the host's request.

Reply drafts and pending request identities use tab-local session storage, while language, appearance and text size use local storage. If browser storage is unavailable, the current page retains in-memory drafts. Session logs remain owned by the Runtime; browser preferences cannot replace their contents or authorize an operation.

**Bring a moment back to char.pub** starts with empty synthetic summary and character fields. It does not prefill the conversation or private playing notes. Review the entire generated file before a separate download action: its committed Story state can still contain secrets. The server rechecks the reviewed state before returning download bytes.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[App.tsx](src/App.tsx) coordinates explicit operations and record-keyed draft recovery. Setup and conversation operations retain the UI operation lock through the local-record refresh, preventing background reads from racing the host's serialized operations. [api.ts](src/api.ts) sends same-origin, nonce-bearing requests and reports uncertain write outcomes separately from explicit rejection. [theme.css](src/theme.css) imports the `ui-theme` token sheets and rebinds their aliases to the char.pub palette; components import `ui-primitives` source modules directly so the bundle excludes the Markdown and code-highlighting stack. [SettingsDialog.tsx](src/components/SettingsDialog.tsx), [ModelsSection.tsx](src/components/ModelsSection.tsx) and [Plugins.tsx](src/components/Plugins.tsx) reproduce the Harness Settings, Models and plugin pages without their Cordis slots; [settings-schema.ts](src/settings-schema.ts) rehydrates the host's schemastery schemas and computes the path edits each save sends. The [Runtime browser DTOs](../../packages/experimental/charpub-roleplay-runtime/src/app-types.ts) limit the data shown by the player.

The [repository build script](../../scripts/build-charpub-replay.mjs) builds the required libraries and static player assets. Run the owner-local tests from the repository root with `pnpm --filter @deepseek-ai/dsh-charpub-roleplay-web run test`. These tests cover DTO-driven interactions and HTTP transport behavior; the Runtime package owns real HTTP, authorization and JSONL recovery tests. Actual browser review verifies layout and contrast beyond the DOM tests.

</details>

<a id="model-experience"></a>
## Model Experience

The player sends only explicit user messages through the Runtime's generation path. It displays completed replies and a real pending status; it does not synthesize streamed text. Configured model information is marked as not verified online; a stored key does not claim connectivity. The page sends an entered key once to the host credential operation and never stores or displays it.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- This player does not automatically confirm inferred plot changes or endings, edit author definitions, or publish a work.
- Saved reply drafts remain browser-tab state; they are not synchronized across devices or merged with another tab's edits.
- Expired draft builds require a new **Try draft** handoff from char.pub. Unsupported required capabilities require a compatible Runtime.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [UI specification](../../spec/roleplay-ui.md) records the product scope. Verification evidence belongs in the [execution record](../../spec/goals/roleplay/PROGRESS.md).

</details>
