---
description: "供 Harness 消费者使用的不可变 char.pub 包 tarball、活动选择及刷新流程。"
---

# char.pub SDK 快照

[English](README.md) | 中文

## 概述

该目录为 Harness 消费者保留编译后的 char.pub 包快照。每个快照都有精确字节哈希，current.json 选择当前集合。保留的快照永不覆盖。

## 目录

- [快照身份](#snapshot-identity)
- [刷新](#refresh)
- [开发备注](#dev-note)

-----

<a id="snapshot-identity"></a>
## 快照身份

这些 Apache-2.0 包 tarball 是 char.pub 的本地构建快照。它们是外部包产物，独立于 `vendor/` 中 MIT 许可的 Cordis 源码副本。每份 `manifest.json` 记录精确字节摘要、包版本和源码版本。`current.json` 选择活动快照并固定其 manifest（元数据清单）摘要。最初的根快照和此前 `snapshots/` 目录保留原字节。`source_dirty: true` 表示包含尚未提交的开发改动，仅凭源码版本无法重现这些字节。tarball 哈希标识此工作副本使用的输入。

`@char-pub/core`、`@char-pub/assembler` 和 `@char-pub/contracts` 导出编译后的 ESM 和 TypeScript 声明。Harness 消费者按包名导入。根 pnpm overrides 将传递导入固定到同一组 tarball。不需要 char.pub 源码目录、schema 副本、source condition 或仓库绝对路径。

<a id="refresh"></a>
## 刷新

在 char.pub 工作副本中运行 `node scripts/pack-runtime-sdk.mjs <new-output-directory>`。新建 `snapshots/<id>/`，将三个 tarball 复制到其 `tarballs/` 子目录，将 manifest 放在该子目录旁，并保留 Apache 许可证。更新 `current.json`、两个 roleplay 包的依赖和根 pnpm overrides，使其指向新目录。运行 `node scripts/verify-charpub-sdk.mjs`，更新 pnpm lockfile，再运行 `pnpm run test:roleplay` 和 `pnpm run test:roleplay-runtime`。校验器检查所有保留快照，并要求直接和传递依赖路径选择活动字节。更换已安装 SDK 前，捕获有代表性的旧回放和 Session 文件；其恢复结果应与新 Session 测试分开报告。不得覆盖保留快照，也不得重写 Session 世代来让记录的摘要匹配新 SDK。

该快照未发布到 npm。它不是上游 DeepSeek 依赖，也不保证在线 Runtime 兼容。在线模型调用、OAuth 和上游 session-loop 组合另有验收检查。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
