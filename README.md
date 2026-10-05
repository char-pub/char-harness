# char-harness

English | [中文](README.zh.md)

char-harness is the local Story roleplay runtime for [char.pub](https://char.pub), maintained by [char-pub](https://github.com/char-pub/char-harness). It combines published characters and stories with a local conversation workspace, exact content versions and durable sessions.

The project builds on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), developed by DeepSeek AI and powered by Cordis. Upstream source history, licenses and extension rules are retained. char.pub owns static authoring and publication; this repository owns play, model requests and local session records.

<a id="run"></a>

<a id="run-from-source"></a>

## Start a roleplay workspace

Use Node.js and pnpm versions from the repository manifest, then build the private browser application and runtime from this checkout:

```sh
git clone https://github.com/char-pub/char-harness.git
cd char-harness
pnpm install
node scripts/build-charpub-replay.mjs
```

Follow the [roleplay profile setup](packages/experimental/charpub-roleplay-runtime/PROFILE.md) to configure your Registry, public OAuth client, model and local session directory. Start it through the named `dsh` profile; the browser application has no separate Node server. The private workspace packages are not published to npm.

Choose a work in char.pub and use **Start playing** or **Try draft in Runtime**. The runtime reviews the exact version, opening and role bindings before starting. Its [browser application](apps/roleplay/README.md) provides local sessions, conversation and story information; connection and technical details have separate controls.

## Behavior and limits

Model credentials stay with the locally configured provider. A configured route is not evidence that a key or online model has been verified. Read the [safety notice](SAFETY.md) before running the project.

The app supports text Story play and preserves the existing Session log. It does not infer plot transitions from free conversation. Jev and Laya decision adapters are available in the [roleplay library](packages/experimental/charpub-roleplay/README.md); the browser profile does not silently enable them. The [runtime README](packages/experimental/charpub-roleplay-runtime/README.md) owns the exact capabilities and recovery rules.

## Development

Start with the [UI design](spec/roleplay-ui.md), [architecture](docs/architecture.md) and [development guide](docs/development.md). The upstream coding, tools and Desktop components remain available; their guides describe those applications separately from roleplay.

Follow [AGENTS.md](AGENTS.md) when changing this repository. Report char-harness issues in [this repository](https://github.com/char-pub/char-harness/issues). The upstream project's documentation is available at [DeepSeek Harness docs](https://deepseek-harness.github.io/deepseek-harness/).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
