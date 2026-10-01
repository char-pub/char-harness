---
kind: upgrade-guide
description: roleplay 浏览器入口现在需要凭据服务和显式的 credential_ref，在 profile 中内联配置 roleplay-app 的用户需要补上这两项。
---

# Roleplay app 凭据设置

[English](guide.md) | 中文

## 变更

`roleplay-app` 条目（`@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app`）现在允许设置对话框查看、保存和移除模型 API 密钥。该条目注入 `credentials` 服务，并要求 `credential_ref` 配置字段，用来指定模型适配器解析的凭据引用，例如 `DEEPSEEK_API_KEY`。`/api/status` 的 `model.credential` 由字符串 `'unverified'` 改为 `{ configured, source?, writable }`；`online_verified` 仍为 `false`。

应用随包 [`app.patch.yml`](../../../../packages/experimental/charpub-roleplay-runtime/app.patch.yml) 的 profile 会从该 overlay 获得 `roleplay-credentials` 条目和 `credential_ref`。在 profile 的 `cordis.patch.yml` 中自行插入 `roleplay-app` 配置的用户，缺少 `credential_ref` 时配置校验失败；没有凭据提供方时该条目不会激活。

## 迁移

1. 在 profile 的 `cordis.patch.yml` 中，为 `roleplay-app` 的 config 添加 `credential_ref: DEEPSEEK_API_KEY`，名称与 `roleplay-model` 条目的 `apiKeyEnv` 一致。
2. 在 `roleplay-app` 之前插入凭据提供方，例如 `{ id: roleplay-credentials, name: '@deepseek-ai/dsh-credentials-local' }`，并确保 profile 能像解析 runtime 和模型包一样解析 `@deepseek-ai/dsh-credentials-local`。
3. 曾把 `model.credential` 与 `'unverified'` 比较的 `/api/status` 客户端，改为读取 `model.credential.configured`。
4. 重启 profile，打开设置 → 模型。启动环境或 `$DSH_HOME/.credentials.yaml` 提供该引用时，API 密钥一行显示**已配置**及其来源。
