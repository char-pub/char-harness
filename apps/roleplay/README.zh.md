---
description: "在本地浏览器游玩 char.pub 精确故事版本，保留不同会话的回复草稿，并核对中断的回复。"
kind: "package-library"
---

# @deepseek-ai/dsh-charpub-roleplay-web

[English](README.md) | 中文

## 概述

选择 char.pub 故事，审阅精确版本与开局，再通过本地模型参与其中。播放器在左侧保存本地故事，中间展示对话，右侧展示当前可见的场景与角色。它可以恢复已保存的会话，并在当前浏览器标签页中为每条记录保留尚未发送的回复。页面沿用 DeepSeek Harness 的布局、控件和设置面板，配色与标识采用 [char.pub 品牌](https://github.com/char-pub/brand-assets)。模型与 Registry 凭据留在已配置的 Harness profile 中。

## 目录

- [使用此应用](#use-this-application)
- [恢复与隐私](#recovery-and-privacy)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-application"></a>
## 使用此应用

通过既有 `dsh --profile` 启动器运行配置好的具名 profile。[Runtime profile 参考](../../packages/experimental/charpub-roleplay-runtime/PROFILE.md)负责说明配置、生成模型提供方和本地地址。这个私有包为该 profile 提供静态资源，没有独立可执行文件或 profile 插件。

打开 profile 的浏览器地址，沿链接进入 char.pub。在 char.pub 作品页选择 **Start playing**，或在编辑器选择 **Try draft**，将精确版本交给当前 Runtime 地址。按提示授权 Registry 访问，查看分级、许可、开局与限制，填写必需角色后，选择**进入故事**。手动启动 JSON 仍保留在**高级**区域。

选择已保存的故事即可恢复。侧栏显示每条记录的真实创建日期与时间；切换记录会保留各自尚未发送的回复。Enter 发送，Shift + Enter 换行。**设置** → **通用设置**可调整界面语言、外观和故事字号，不会改变故事的内容语言。**模型**列出每个可配置的提供方及其密钥状态；**编辑**会打开对应卡片，可填写 API 密钥，并在**自定义设置**中修改 API 地址和模型目录。密钥保存到 profile 的本机 Harness 凭据，地址和目录写入 profile 的 `cordis.patch.yml`；来自启动环境的密钥和由 `--patch` 叠加层占用的条目显示为只读。**内置插件**列出正在运行的插件及其模块和运行状态。**char.pub 访问**用于授权 Registry 读取。侧栏的**插件**页列出同样的插件；带可热更新字段的插件会打开自动生成的配置表单，模型适配器会打开**模型**页。窄屏将两侧面板收进可用键盘操作的抽屉。

<a id="recovery-and-privacy"></a>
## 恢复与隐私

请求结果不明确时，先检查状态再重试。确认未被记录的请求，可以明确使用同一 ID 和原文重新发送。持久化的中断请求需要先核对，再明确结束，之后才能发送新消息。取消只是在请求停止；已经完成的回复仍可能保存。关闭页面不代表主机上的请求已取消。

回复草稿和待确认请求身份使用标签页级 session storage，语言、外观和字号使用 local storage。如果浏览器存储不可用，当前页面仍保留内存草稿。Session 日志由 Runtime 负责；浏览器偏好不能替代日志内容，也不能授予操作权限。

**把这一刻带回 char.pub** 使用空白的合成摘要与角色字段，不会预填聊天记录或游玩时的私密设定。在单独下载之前，请审阅生成文件的完整内容：其中已提交的剧情状态仍可能包含秘密。服务端会再次核对已审阅的状态，才返回可下载字节。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

[App.tsx](src/App.tsx)协调明确操作和按记录标识保存的草稿恢复。准备与对话操作在刷新本地记录之后才释放界面操作锁，避免后台读取与主机串行操作竞争。[api.ts](src/api.ts)发送携带 nonce 的同源请求，区分结果不明确的写入与明确拒绝。[theme.css](src/theme.css)引入 `ui-theme` 的 token 表，并把其中的 alias 改绑到 char.pub 配色；组件直接引用 `ui-primitives` 的源码模块，因此打包结果不含 Markdown 与代码高亮依赖。[SettingsDialog.tsx](src/components/SettingsDialog.tsx)、[ModelsSection.tsx](src/components/ModelsSection.tsx) 和 [Plugins.tsx](src/components/Plugins.tsx) 在不依赖 Cordis 插槽的前提下复刻 Harness 的设置、模型和插件页面；[settings-schema.ts](src/settings-schema.ts) 还原 Host 下发的 schemastery schema，并计算每次保存发送的路径编辑。[Runtime 浏览器 DTO](../../packages/experimental/charpub-roleplay-runtime/src/app-types.ts)限制播放器可以显示的数据。

[仓库构建脚本](../../scripts/build-charpub-replay.mjs)构建必需库和播放器静态资源。在仓库根目录运行 `pnpm --filter @deepseek-ai/dsh-charpub-roleplay-web run test` 可执行应用测试。这些测试覆盖 DTO 驱动的交互与 HTTP 传输行为；Runtime 包负责真实 HTTP、授权和 JSONL 恢复测试。实际浏览器审阅补充 DOM 测试无法证明的布局与对比度验证。

</details>

<a id="model-experience"></a>
## 模型体验

播放器仅通过 Runtime 生成路径发送明确提交的用户消息。它显示完整回复和真实的等待状态，不合成流式文本。已配置模型的信息标记为尚未在线验证，保存了密钥也不代表已确认连通。页面只把输入的密钥发送一次给 Host 凭据操作，不会保存或显示它。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 播放器不会自动确认推断出的剧情变化或结尾，不会编辑作者定义或发布作品。
- 已保存的回复草稿仍是浏览器标签页状态，不跨设备同步，也不会与另一标签页的编辑合并。
- 草稿构建过期后，需要从 char.pub 重新执行 **Try draft**。缺少必需能力时，需要选择兼容的 Runtime。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

[UI 规范](../../spec/roleplay-ui.md)记录产品范围。验证证据保存在[执行记录](../../spec/goals/roleplay/PROGRESS.md)中。

</details>
