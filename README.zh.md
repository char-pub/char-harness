# char-harness

[English](README.md) | 中文

char-harness 是 [char.pub](https://char.pub) 的本地剧情扮演运行时，由 [char-pub](https://github.com/char-pub/char-harness) 维护。它把已发布角色和故事接入本地对话工作区，使用精确内容版本并持久保存会话。

本项目基于 DeepSeek AI 开发、由 Cordis 驱动的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。上游源码历史、许可和扩展规则均予保留。char.pub 负责静态创作与发布；本仓库负责游玩、模型请求和本地会话记录。

<a id="run"></a>

<a id="run-from-source"></a>

## 启动游玩工作区

使用仓库 manifest 指定的 Node.js 和 pnpm 版本，然后从本仓库构建私有浏览器应用和运行时：

```sh
git clone https://github.com/char-pub/char-harness.git
cd char-harness
pnpm install
node scripts/build-charpub-replay.mjs
```

按照 [roleplay profile 配置说明](packages/experimental/charpub-roleplay-runtime/PROFILE.md) 设置 Registry、公共 OAuth 客户端、模型和本地会话目录。应用通过命名 `dsh` profile 启动，浏览器应用没有独立的 Node 服务器。这些私有 workspace 包尚未发布到 npm。

在 char.pub 选择作品，点击 **Start playing** 或 **Try draft in Runtime**。运行时先审阅精确版本、开局和角色绑定，再开始游玩。[浏览器应用](apps/roleplay/README.zh.md) 提供本地会话、对话和剧情资料；连接与技术细节使用独立入口。

## 行为与限制

模型凭据保留在本机配置的提供方中。配置了模型路由不代表密钥或在线模型已经验证。运行前请阅读[安全说明](SAFETY.zh.md)。

应用支持文本 Story 游玩，并保留现有 Session 日志。自由对话不会自动推断剧情转移。[roleplay 库](packages/experimental/charpub-roleplay/README.zh.md) 提供 Jev 和 Laya 决策适配器，浏览器 profile 不会默默启用它们。精确能力与恢复规则见[运行时 README](packages/experimental/charpub-roleplay-runtime/README.zh.md)。

## 开发

从 [UI 设计](spec/roleplay-ui.md)、[架构](docs/architecture.zh.md) 和[开发指南](docs/development.zh.md) 开始。上游编程、工具和 Desktop 组件仍可使用，其指南与 roleplay 应用分别说明。

修改本仓库时遵循 [AGENTS.md](AGENTS.md)。char-harness 的问题反馈到[本仓库](https://github.com/char-pub/char-harness/issues)。上游项目文档见 [DeepSeek Harness docs](https://deepseek-harness.github.io/deepseek-harness/)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
