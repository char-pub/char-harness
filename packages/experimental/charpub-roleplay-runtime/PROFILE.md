# Roleplay base profile

This private experimental package is also a Cordis bundle. It supplies reusable Session, LLM, JSONL storage and roleplay runtime services. The base bundle supplies no frontend or model adapter. The optional app overlay below adds a local browser entry and an explicitly configured provider. Loading this bundle alone does not start a game or call a model.

## Named profile manifest

Initialize a profile directory named `roleplay` under the chosen Harness home. Its `package.json` must explicitly select this one bundle:

```json
{
  "name": "dsh-profile-roleplay",
  "private": true,
  "type": "module",
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-experimental-charpub-roleplay-runtime"]
    }
  }
}
```

The bundle must be installed where that profile or its owning dsh installation resolves it. It is a private workspace package in this checkout, not an available public npm release. Maintainer tests resolve the actual workspace dependency from the Harness root installation anchor. Do not initialize a missing profile through a command that implicitly adds `dsh-base`; the roleplay manifest owns its explicit bundle list.

The existing dsh launcher selects the initialized profile with `--profile roleplay`. This package adds no executable. The optional local browser entry uses this same launcher; it adds no second executable.

## Explicit configuration

The bundle has exactly four named entries:

| Entry ID | Package |
|---|---|
| `roleplay-session` | `@deepseek-ai/dsh-session` |
| `roleplay-llm` | `@deepseek-ai/dsh-llm` |
| `roleplay-storage` | `@deepseek-ai/dsh-session-persistence-jsonl` |
| `roleplay-runtime` | `@deepseek-ai/dsh-experimental-charpub-roleplay-runtime` |

There is no default agent loop, system-prompt assembly, tool registry, shell or browser in this bundle. JSONL compression is explicitly `none`. Storage root and runtime limits have no deployment defaults. Supply `CHARPUB_SESSION_ROOT`, `CHARPUB_REQUEST_TIMEOUT_MS`, `CHARPUB_MAX_EVENT_BYTES` and `CHARPUB_MAX_STREAM_BYTES`, or replace both rows in the profile's `cordis.patch.yml`:

```yaml
- id: roleplay-storage
  config:
    root: /explicit/owner-controlled/session-directory
    compression: none
- id: roleplay-runtime
  config:
    timeout_ms: 30000
    max_event_bytes: 2000000
    max_stream_bytes: 500000
```

These values are example choices, not calibrated product defaults. A patch replaces each row's complete config, so include every required runtime limit. Missing or invalid configuration prevents the affected service from activating. The caller must handle activation errors before offering a session action.

A generation adapter and a caller entry can be added as later profile patches or explicit bundles. They must resolve through the installed profile's declared dependencies. Credential setup belongs to that selected adapter; this base bundle does not read model credentials or choose a provider.

## Verification

`tests/profile.test.ts` uses a fresh temporary Harness home and the real `initProfile`, `loadProfile('roleplay', ...)` and `composeEntries` implementations. It checks the bundle's exact entry allowlist, applies explicit user configuration, then mounts the resulting entries through the real Cordis Loader. Source-plane module resolution uses each package's declared `./src` export rather than mocking its services.

The test adds only an injected, network-free generation provider. It creates a real JSONL-backed Session, runs one roleplay request, and compares the provider's exact messages with the requested Session record. It also checks that the coding loop, prompt assembly and tools were not mounted. It disposes the Loader and removes its temporary storage.

```sh
node --import tsx/esm --test packages/experimental/charpub-roleplay-runtime/tests/profile.test.ts
```

This is composition evidence, not a built CLI, Web client, online provider or live model-quality test. The service and persistence behavior is documented in [README.md](README.md).


## Local browser entry

After initializing the named profile above, apply this package's `app.patch.yml` through the supported launcher:

```sh
DSH_HOME=/explicit/owner-controlled/harness-home pnpm dsh --profile roleplay --patch packages/experimental/charpub-roleplay-runtime/app.patch.yml
```

In an installed distribution, use the installed package's patch path. The profile must resolve this private runtime package, `@deepseek-ai/dsh-llm-deepseek-api-key`, `@deepseek-ai/dsh-credentials-local`, `@deepseek-ai/dsh-config-editor` and `@deepseek-ai/dsh-settings`. Build the product exports before launching from this checkout with `node scripts/build-charpub-replay.mjs`. The overlay uses `deepseek-official` and names `DEEPSEEK_API_KEY` as the app's `credential_ref`. The `roleplay-credentials` entry resolves keys from the launching environment, then `$DSH_HOME/.credentials.yaml` and `.env` files; Settings writes only `$DSH_HOME/.credentials.yaml`, which DeepSeek Harness shares under the same `DSH_HOME`. The key is never copied into a launch or Session.

Settings writes live fields such as the DeepSeek `baseURL` and `models` catalog to the profile's own `cordis.patch.yml` through `roleplay-settings`, which runs only under the `dsh` launcher's profile context. Rows a `--patch` overlay inserts are composed after that file, so Settings shows their fields read-only; API keys stay writable because they go to the credential store. To edit the model endpoint and catalog, copy the overlay's insert rows into the profile's `cordis.patch.yml` and launch with `dsh --profile roleplay` alone. A profile that inserts `roleplay-app` with its own config must also supply `credential_ref`, the settings rows and a credentials provider ([upgrade guide](../../../docs/upgrade-guide/v0.2.0-rc.2/roleplay-app-credentials/guide.md)).

Supply `CHARPUB_APP_PORT`, `CHARPUB_REGISTRY_ORIGIN`, `CHARPUB_OAUTH_ISSUER`, `CHARPUB_OAUTH_CLIENT_ID`, `CHARPUB_APP_REQUEST_BYTES`, `CHARPUB_APP_RESPONSE_BYTES`, `CHARPUB_APP_ARTIFACT_BYTES`, `CHARPUB_CONTEXT_WINDOW`, `CHARPUB_OUTPUT_TOKENS` and `CHARPUB_MODEL`, in addition to the storage/runtime variables above. These are local deployment choices, with no implicit provider or endpoint from browser input. An explicit profile row may replace the complete app configuration instead.

For example, port `19389` gives `http://127.0.0.1:19389/`; manually register exactly `http://127.0.0.1:19389/oauth/callback` as the public OAuth client's redirect. Grant `creations:read` and `offline_access`. Open the local page or select that actual URL from char.pub. The page consumes `#launch=<encoded JSON>` using the shared `RuntimeLaunchRequest` schema, removes the fragment from the current address, and retains only the launch locator in that tab's session storage during authorization. No token, body, signed asset URL or Session identity belongs in the launch.

When opened without a launch, the welcome page links to the configured Registry and displays this Runtime’s address. On char.pub, choose a Story and select **Start playing**, or use **Try draft** in your editor, then choose that Runtime address. Manual launch JSON is available under **Advanced: paste launch JSON**. No session can start until a work is supplied and reviewed.

Authorize, review the aggregate rating, licenses and capability limitations, then choose the opening/viewpoint and supply late-bound character values. Starting creates a new log and makes no model call until a reply is submitted. Reopening a different draft build asks to start a new Session; it does not upgrade the old log. The local page handles one active workspace, and old tabs fail with `stale_session` after replacement.

This entry is text-only Story play with `noneSelection`; optional semantic materials are not selected and model judgments stay undetermined. The reusable Jev/Laya adapters are not enabled by this overlay. It does not provide full game navigation, a credential vault or automatic action inference. Preview export requires a separate synthetic summary and empty synthetic character fields, followed by review and confirmation.

`tests/app.test.ts` mounts the actual named profile and HTTP entry with real JSONL services, an offline model provider and a local Registry protocol fixture. It covers exact identity checks, unsupported input, cancellation, Host/Origin denial, old-tab rejection and synthetic export without private play descriptions. This is not an online model-quality test. The cross-repository browser suite separately uses the real Registry, OAuth and supported dsh launcher.

### Local record recovery and reply state

The compiled browser client is served by the existing profile HTTP entry; it has no separate application server or launcher. Build the runtime and client together with the command above before starting the profile. The primary page shows dialogue, visible participants and the current scene, with connection/configuration and exact JSON in secondary views.

The page lists a bounded page of records from the configured JSONL root. Selecting a stored game checks its original exact source and current Registry access, then resumes its committed history without repeating the opening. An expired draft or inaccessible source remains a clear error; the app does not create a replacement build. Restarting the server changes operation handles, but the local record key remains stable so browser reply drafts can be associated with the same record after listing and resuming it.

A lost reply response is reconciled by its original request ID. It is not retried under a new ID automatically. An unfinished stored request is displayed as interrupted; only an explicit recovery choice followed by a new reply ends that request and starts one new generation. Merely listing, selecting or inspecting a record does not change its log. Stop addresses the current request, and the page shows actual sending and settled results rather than simulated streaming.

The status endpoint reports local grant availability and the fixed model route. Credentials are unverified unless their actual provider supplies evidence; a configured model is not an online connection test. This profile does not add a credential vault or perform inference when the page loads. Keep real keys in the selected provider's documented local configuration, never in launch data or browser storage.
