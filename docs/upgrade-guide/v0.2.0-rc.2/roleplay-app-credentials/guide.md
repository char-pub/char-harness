---
kind: upgrade-guide
description: The roleplay browser entry now requires a credentials service and an explicit credential_ref, so profiles that configure roleplay-app inline must add both.
---

# Roleplay app credential settings

English | [中文](guide.zh.md)

## Change

The `roleplay-app` entry (`@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app`) now lets the Settings dialog describe, store and remove the model API key. The entry injects the `credentials` service and requires a `credential_ref` config field that names the reference the model adapter resolves, such as `DEEPSEEK_API_KEY`. `/api/status` reports `model.credential` as `{ configured, source?, writable }` instead of the string `'unverified'`; `online_verified` stays `false`.

Profiles that apply the shipped [`app.patch.yml`](../../../../packages/experimental/charpub-roleplay-runtime/app.patch.yml) receive the `roleplay-credentials` entry and `credential_ref` from the overlay. A profile `cordis.patch.yml` that inserts `roleplay-app` with its own config fails config validation without `credential_ref`, and the entry does not activate without a credentials provider.

## Migration

1. In the profile `cordis.patch.yml`, add `credential_ref: DEEPSEEK_API_KEY` to the `roleplay-app` config. Use the same name as the `apiKeyEnv` of the `roleplay-model` entry.
2. Insert a credentials provider before `roleplay-app`, for example `{ id: roleplay-credentials, name: '@deepseek-ai/dsh-credentials-local' }`. Make `@deepseek-ai/dsh-credentials-local` resolvable from the profile, as the runtime and model packages already are.
3. Clients of `/api/status` that compared `model.credential` with `'unverified'` read `model.credential.configured` instead.
4. Restart the profile and open Settings → Model. The API key row shows **Configured** with its source when the launching environment or `$DSH_HOME/.credentials.yaml` supplies the reference.
