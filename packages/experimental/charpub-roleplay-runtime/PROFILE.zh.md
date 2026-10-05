# 角色扮演基础 profile

[English](PROFILE.md) | 中文

这个私有实验性包也是 Cordis bundle，提供可复用的 Session、LLM、JSONL 存储和角色扮演运行时服务。基础 bundle 不包含前端或模型适配器。下面的可选 app overlay 添加本地浏览器入口与显式配置的提供方。只加载 bundle 不会开始游戏或调用模型。

## 命名 profile 清单

在选定的 Harness home 下初始化名为 `roleplay` 的 profile 目录。其 `package.json` 必须显式选择这一个 bundle：

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

bundle 必须安装在该 profile 或所属 dsh 安装能够解析的位置。它是本 checkout 的私有 workspace 包，不是可从公共 npm 获取的发行版。维护测试从 Harness 根安装入口解析实际 workspace 依赖。不要用会隐式加入 `dsh-base` 的命令初始化缺失的 profile；角色扮演清单明确拥有自己的 bundle 列表。

现有 dsh 启动器通过 `--profile roleplay` 选择已初始化的 profile。本包不增加可执行入口。可选本地浏览器入口也使用同一个启动器，不增加第二个可执行程序。

## 显式配置

bundle 恰好包含四个命名条目：

| 条目 ID | 包 |
|---|---|
| `roleplay-session` | `@deepseek-ai/dsh-session` |
| `roleplay-llm` | `@deepseek-ai/dsh-llm` |
| `roleplay-storage` | `@deepseek-ai/dsh-session-persistence-jsonl` |
| `roleplay-runtime` | `@deepseek-ai/dsh-experimental-charpub-roleplay-runtime` |

这个 bundle 不含默认 agent loop、system-prompt 组装、工具注册表、shell 或浏览器。JSONL 压缩显式设为 `none`。存储根目录和运行时限额没有部署默认值。请提供 `CHARPUB_SESSION_ROOT`、`CHARPUB_REQUEST_TIMEOUT_MS`、`CHARPUB_MAX_EVENT_BYTES` 和 `CHARPUB_MAX_STREAM_BYTES`，或在 profile 的 `cordis.patch.yml` 中替换两条配置：

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

这些数值只是示例选择，不是经过校准的产品默认值。patch 会替换一条记录的完整 config，因此须包含所有必需运行时限额。配置缺失或无效会阻止对应服务激活。调用方必须先处理激活错误，再提供会话操作。

生成适配器和调用入口可通过后续 profile patch 或显式 bundle 加入，必须能从该 profile 已声明、已安装的依赖中解析。凭据设置属于选定适配器；基础 bundle 不读取模型凭据，也不选择提供方。

## 验证

`tests/profile.test.ts` 使用全新临时 Harness home 与真实的 `initProfile`、`loadProfile('roleplay', ...)`、`composeEntries` 实现，检查 bundle 精确条目白名单，应用显式用户配置，再经真实 Cordis Loader 挂载组合后的条目。源码测试通过每个包声明的 `./src` export 解析模块，不模拟其服务。

测试使用注入的离线生成提供方，以及连接本地 HTTP fixture 的官方 DeepSeek 适配器。真实 JSONL Session 保留精确派发消息；适配器测试校验完整 system 区域文本，并确认独立配置的决策路由使用低强度思考、叙述关闭思考。同时检查 coding loop、提示词组装和工具没有挂载，结束后释放 Loader 并删除临时存储。

```sh
node --import tsx/esm --test packages/experimental/charpub-roleplay-runtime/tests/profile.test.ts
```

这是组合证据，不是构建后 CLI、Web 客户端、在线提供方或真实模型质量测试。服务与持久化行为见 [README.zh.md](README.zh.md)。

## 本地浏览器入口

初始化上述命名 profile 后，通过受支持的启动器应用本包的 `app.patch.yml`：

```sh
DSH_HOME=/explicit/owner-controlled/harness-home pnpm dsh --profile roleplay --patch packages/experimental/charpub-roleplay-runtime/app.patch.yml
```

已安装发行版应使用安装包内的 patch 路径。profile 必须能解析这个私有 runtime 包，以及 `@deepseek-ai/dsh-llm-deepseek-api-key`、`@deepseek-ai/dsh-credentials-local`、`@deepseek-ai/dsh-config-editor` 和 `@deepseek-ai/dsh-settings`。从本 checkout 启动前，先运行 `node scripts/build-charpub-replay.mjs` 构建产品 export。overlay 使用 `deepseek-official`，并把 `DEEPSEEK_API_KEY` 设为 app 的 `credential_ref`。`roleplay-credentials` 先读取启动环境，再读取 `$DSH_HOME/.credentials.yaml` 和 `.env` 文件；Settings 仅写入 `$DSH_HOME/.credentials.yaml`，相同 `DSH_HOME` 下的 DeepSeek Harness 共用该文件。密钥不会复制到 launch 或 Session。

Settings 经 `roleplay-settings` 将 DeepSeek `baseURL`、`models` catalog 等实时字段写入 profile 自身的 `cordis.patch.yml`；该服务仅在 dsh 启动器的 profile 上下文中工作。`--patch` overlay 插入的条目在此文件之后组合，因此 Settings 将这些字段显示为只读；API key 写入凭据存储，仍可编辑。若需编辑模型端点与 catalog，请把 overlay 的 insert 条目复制到 profile 的 `cordis.patch.yml`，只以 `dsh --profile roleplay` 启动。自行插入并配置 `roleplay-app` 的 profile 还须提供 `credential_ref`、settings 条目及凭据提供方，见[升级指南](../../../docs/upgrade-guide/v0.2.0-rc.2/roleplay-app-credentials/guide.zh.md)。

除前述存储与运行时变量外，还需提供 `CHARPUB_APP_PORT`、`CHARPUB_OAUTH_CLIENT_ID`、`CHARPUB_APP_REQUEST_BYTES`、`CHARPUB_APP_RESPONSE_BYTES`、`CHARPUB_APP_ARTIFACT_BYTES`、`CHARPUB_CONTEXT_WINDOW`、`CHARPUB_OUTPUT_TOKENS` 和 `CHARPUB_MODEL`。Registry 默认是 `https://char.pub`，issuer 是 `https://char.pub/v1/auth`；使用本地开发服务器等其他 Registry 时，应同时设置 `CHARPUB_REGISTRY_ORIGIN` 与 `CHARPUB_OAUTH_ISSUER`。这些都是本地部署选择，浏览器输入不会隐式提供模型或端点。也可通过显式 profile 条目替换整个 app 配置。

例如端口 `19389` 对应 `http://127.0.0.1:19389/`；请为公共 OAuth 客户端手动登记精确的 `http://127.0.0.1:19389/oauth/callback` redirect，并授权 `creations:read` 与 `offline_access`。打开本地页面，或从 char.pub 选择这一实际 URL。页面使用共享 `RuntimeLaunchRequest` Schema 读取 `#launch=<encoded JSON>`，从当前地址删除 fragment，授权期间只在该标签页 session storage 中保留 launch locator。launch 不包含 token、正文、签名资产 URL 或 Session 身份。

无 launch 时，欢迎页链接到配置的 Registry 并显示本 Runtime 地址。在 char.pub 选择 Story 并点击 **Start playing**，或在编辑器中点击 **Try draft**，然后选择该 Runtime 地址。手动 launch JSON 位于 **Advanced: paste launch JSON**。提供并审阅作品前不能开始会话。

授权、检查聚合评级、许可及能力限制，然后选择开场/视角并填写延迟绑定的人物值。开始时创建新日志，只有提交回复后才调用模型。重新打开另一份草稿构建需要确认新建 Session，不会升级旧日志。本地页面只处理一个活动 workspace，替换后旧标签页会收到 `stale_session`。

本地入口通过 `play` 发送玩家回复：配置的 LLM 提议作者声明的动作与判定，经 SDK 目录选择相关上下文，然后叙述。`Story.player` 指定受控演员身份；没有声明的内容保留旧用户角色。回复成功后，输入与已接受动作一起提交。页面展示投影后的目标、作者声明的可用选项和已结算进展，并可在不再调用模型的情况下撤回最近一条成功回合。预览导出仍要求单独的合成摘要与空白合成人物字段，再经审阅与确认。

结局提案等待玩家单独确认。继续聊天会替换或清除提案，确认则进行一次叙述并提交结局。hidden 和 on-reach 结局在此审阅中不展示标题或描述。确认失败保留提案；响应丢失时使用同一请求 ID 核对结果，撤回恢复确认回合之前的状态与提案。普通对话和场景进展仍自动处理，模型仍可能判断错误。

overlay 的 `model` 路由通过 `CHARPUB_MODEL` 控制叙述，设置 `reasoningEffort: off`。`play.decisions` 路由优先使用已设置的 `CHARPUB_DECISION_MODEL`，否则使用 `CHARPUB_MODEL`，并采用相同的 `deepseek-official` 提供方、`reasoningEffort: low`、`temperature: 0` 和 `maxTokens: 12288`。决策额度包含隐藏推理和必需 JSON；额度不足时仍可能没有可用决策。零温度用于结构决策与检索，叙述保留独立采样配置。`play.limits` 设置 `min_confidence: 0.8`、`max_actions: 4`、`max_decision_calls: 3` 和 `max_decision_tokens: 64000`。这些示例限额允许更大的推理预算，同时增加延迟与 token 成本；它们不保证正确识别意图。替换 app 条目的 profile 可选择其他路由与限额；省略 `play` 会保留旧显式输入 app 路径。加载页面或打开 Session 都不调用决策模型。

决策调用数包含 director 与每次渐进 selector 展开，叙述另行计数。token 限额为每次获准决策预留估算输入和最大输出，取得实际用量后按其计入。含糊、不可用或超限决策不建立效果。目录深度可能耗尽示例中的三次调用限额；选材此时使用带记录的 skip Plan，保留 required/direct 资料。回合超时覆盖所有阶段及存储完成，应按配置提供方的总回合延迟选择。

回合中可以选择可选内联片段。Source 正文保持为创建 Session 时取得并校验的固定快照；app 不在游玩时下载新选中的外部 Source。若 Plan 需要缺失的 Source 正文，准备会失败且不提交回合。请使用可选内联资料，或在创建 Session 时包含必需 Source 正文。这个 overlay 不要求 Jev/Laya 服务，初始开场判定仍需显式提供。

`tests/app.test.ts` 使用离线模型提供方、本地 Registry 协议 fixture 和真实 JSONL 服务，挂载实际命名 profile 与 HTTP 入口，覆盖精确身份检查、不支持的输入、取消、Host/Origin 拒绝、旧标签页拒绝，以及不包含私密游玩描述的合成导出。它不验证在线模型质量。跨仓库浏览器套件另行使用真实 Registry、OAuth 和受支持的 dsh 启动器。

### 本地记录恢复与回复状态

编译后的浏览器客户端由现有 profile HTTP 入口提供，不含独立应用服务器或启动器。启动 profile 前，先用上述命令一起构建 runtime 与客户端。主页面显示对话、可见人物和当前场景；连接、配置及精确 JSON 放在次要视图。

页面从配置的 JSONL 根目录列出有界的一页记录。选择存储游戏时，先校验原始精确来源与当前 Registry 访问权，再恢复已提交历史，不重复开场。过期草稿或不可访问来源保留明确错误，app 不创建替代构建。重启服务器会改变操作句柄，但本地记录 key 保持稳定，列出并恢复同一记录后可重新关联浏览器回复草稿。

回复响应丢失后通过原请求 ID 核对，不会自动换新 ID 重试。未完成请求显示为已中断；只有明确选择恢复并发送新回复，才会结束旧请求并开始一次新生成。列出、选择或检查记录不修改日志。停止针对当前请求，页面展示实际发送和结算结果，不模拟流式输出。

status 端点报告本地授权可用性和固定模型路由。除非实际提供方给出证据，凭据仍未经验证；模型已配置不等于在线连接测试。这个 profile 不增加凭据保险库，也不在加载页面时推理。真实密钥应保存在选定提供方记录的本地配置中，不应放入 launch 数据或浏览器存储。
