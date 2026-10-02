---
kind: upgrade-guide
description: roleplay 浏览器入口现在需要凭据服务和显式的 credential_ref，其设置页通过 settings 服务写入模型字段，因此内联配置 roleplay-app 的 profile 需要补上这两项。
---

# Roleplay app 设置与凭据

[English](guide.md) | 中文

## 变更

`roleplay-app` 条目（`@deepseek-ai/dsh-experimental-charpub-roleplay-runtime/app`）现在提供 Harness 的设置页面。**模型**页列出 `llm.listConfigurableProviders()` 返回的可配置提供方，通过 `credentials` 服务保存 API 密钥，并通过 `settings` 服务把可热更新的提供方字段（`baseURL`、`models`）写入 profile 的 `cordis.patch.yml`。**内置插件**页和侧栏**插件**页读取 Loader 插件清单，并为可热更新字段生成配置表单。

该条目注入 `credentials`、`llm` 和 `loader`，并要求 `credential_ref` 配置字段，用来指定提供方未声明 `apiKeyEnv` 时使用的凭据引用，例如 `DEEPSEEK_API_KEY`。`/api/status` 的 `model.credential` 由 `'unverified'` 改为 `{ configured, source?, writable }`；`online_verified` 仍为 `false`。上一个预览构建的 `/api/credential` 路由已由 `/api/settings/*` 取代。

随包的 [`app.patch.yml`](../../../../packages/experimental/charpub-roleplay-runtime/app.patch.yml) 会插入 `roleplay-config-editor`、`roleplay-settings` 和 `roleplay-credentials`。`--patch` 叠加层插入的条目在 profile 的 `cordis.patch.yml` 之后组合，因此设置页把它们的字段显示为只读。在 profile 中自行插入 `roleplay-app` 配置的用户，缺少 `credential_ref` 时配置校验失败。

## 迁移

1. 在 profile 的 `cordis.patch.yml` 中，为 `roleplay-app` 的 config 添加 `credential_ref: DEEPSEEK_API_KEY`。
2. 在 `roleplay-app` 之前插入 `{ id: roleplay-config-editor, name: '@deepseek-ai/dsh-config-editor' }`、`{ id: roleplay-settings, name: '@deepseek-ai/dsh-settings' }` 和 `{ id: roleplay-credentials, name: '@deepseek-ai/dsh-credentials-local' }`，并确保 profile 能像解析 runtime 和模型包一样解析这些包。
3. 如需在设置页修改模型的 API 地址和目录，把这些条目和 `roleplay-model` 留在 profile 的 `cordis.patch.yml` 中，并且不带 `--patch` 启动；设置页会把叠加层占用的条目标为只读。
4. 曾把 `model.credential` 与 `'unverified'` 比较的 `/api/status` 客户端，改为读取 `model.credential.configured`。
5. 重启 profile，打开设置 → 模型。启动环境或 `$DSH_HOME/.credentials.yaml` 提供密钥时，DeepSeek 一行显示绿色圆点；保存 API 地址后，`cordis.patch.yml` 中 `roleplay-model` 下会出现 `baseURL`。
