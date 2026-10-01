---
kind: upgrade-guide
description: The roleplay browser entry now requires a credentials service and an explicit credential_ref, and its Settings writes model fields through the settings service, so inline roleplay-app profiles must add both.
---

# Roleplay app settings and credentials

English | [中文](guide.zh.md)

## Change

The `roleplay-app` entry (`@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app`) now serves the Harness Settings pages. **Models** lists the configurable providers from `llm.listConfigurableProviders()`, stores API keys through the `credentials` service and writes live provider fields (`baseURL`, `models`) through the `settings` service into the profile's `cordis.patch.yml`. **Built-in plugins** and the sidebar **Plugins** page read the Loader inventory and edit generated forms for live fields.

The entry injects `credentials`, `llm` and `loader`, and requires a `credential_ref` config field naming the reference used when a provider names no `apiKeyEnv`, such as `DEEPSEEK_API_KEY`. `/api/status` reports `model.credential` as `{ configured, source?, writable }` instead of `'unverified'`; `online_verified` stays `false`. The `/api/credential` routes of the previous preview build are replaced by `/api/settings/*`.

The shipped [`app.patch.yml`](../../../../packages/experimental/charpub-roleplay-runtime/app.patch.yml) inserts `roleplay-config-editor`, `roleplay-settings` and `roleplay-credentials`. Rows a `--patch` overlay inserts are composed after the profile's `cordis.patch.yml`, so Settings shows their fields read-only. Profiles that insert `roleplay-app` with their own config fail validation without `credential_ref`.

## Migration

1. In the profile `cordis.patch.yml`, add `credential_ref: DEEPSEEK_API_KEY` to the `roleplay-app` config.
2. Before `roleplay-app`, insert `{ id: roleplay-config-editor, name: '@deepseek-ai/dsh-config-editor' }`, `{ id: roleplay-settings, name: '@deepseek-ai/dsh-settings' }` and `{ id: roleplay-credentials, name: '@deepseek-ai/dsh-credentials-local' }`. Make these packages resolvable from the profile, as the runtime and model packages already are.
3. To edit the model endpoint and catalog in Settings, keep these rows and `roleplay-model` in the profile `cordis.patch.yml` and launch without `--patch`; Settings marks overlay-owned entries read-only.
4. Clients of `/api/status` that compared `model.credential` with `'unverified'` read `model.credential.configured` instead.
5. Restart the profile and open Settings → Models. DeepSeek shows a green dot when the launching environment or `$DSH_HOME/.credentials.yaml` supplies the key; saving an API endpoint adds `baseURL` under `roleplay-model` in `cordis.patch.yml`.
