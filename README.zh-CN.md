<p align="center">
  <img src="sites/product/public/logo.svg" alt="NexusPilot" width="120" />
</p>

<h1 align="center">NexusPilot</h1>

<p align="center">
  <b>用自然语言和你的数据库对话</b><br/>
  面向开发者和数据团队的专业数据工作台，把多源连接、结构浏览、查询编辑和 AI 辅助分析整合到一个高效的桌面环境。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/Tauri-2.0-4B5563.svg" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/React-19-61DAFB.svg" alt="React 19" />
  <img src="https://img.shields.io/badge/Rust-2021-000000.svg" alt="Rust" />
  <img src="https://img.shields.io/badge/AI%20Runtime-Bun%20%2B%20Elysia-000000.svg" alt="AI Runtime: Bun + Elysia" />
</p>

[English](./README.md) | 简体中文

**NexusPilot** 基于 **Tauri v2**、**React 19** 与 **Rust** 构建，并配有一个由 **Bun + Elysia + Vercel AI SDK** 驱动的本地 **AI Runtime** 侧车。

---

## ✨ 核心特性

- **驾驭每一种数据形态**：在同一桌面工作区连接并管理持续扩展的关系型、键值型、分析型数据源；按各自特性浏览对象、查看数据并完成日常操作，而不是把所有引擎塞进同一种表格界面。
- **让 AI 成为懂数据的副驾**：AI 助手基于已打开的连接、真实的对象结构与查询结果协助探索、生成 SQL 和分析数据；它通过受限工具访问工作台，而不是凭空猜测数据库。
- **每一次变更，都经得起验证**：AI 发起的 SQL 与 Redis 写操作都要经过风险分析和审批；支持预览的表格与原生结构变更会在执行前展示计划，并在关键变更时核对远端状态。
- **尊重每个引擎的原生表达**：以能力模型适配不同数据库引擎，对未知语义或无法安全验证的操作保持只读。
- **从连接到洞察，一气呵成**：从连接树逐层进入数据库对象，在带上下文的 SQL 标签页中执行和保存查询，再回到数据网格或 AI 对话继续分析——所有环节在同一工作区协同。
- **安全，从边界开始**：原生桌面应用承载数据库连接；独立的本地 AI Runtime 管理模型与提供商配置，前端不直接保存或调用 LLM 凭据。
- **NexusPilot Cloud**：通过端到端加密在已授权设备之间同步保存的连接和文件夹，并提供设备授权与 Recovery Key 恢复流程。Cloud 保存的是加密资产，不接收明文连接凭据；桌面工作台无需 Cloud 也可以独立使用。

## 🗄️ 支持的数据库

| 数据库 | 状态 |
|---|---|
| **PostgreSQL** | ✅ 支持 |
| **MySQL** | ✅ 支持 |
| **SQLite** | ✅ 支持 |
| **Redis** | ✅ 支持 |
| **ClickHouse** | ✅ 支持 |
| **Oracle** | ✅ 支持 |

> 此表列出当前支持的连接驱动。具体可用操作会受数据库引擎、服务端版本、用户权限以及运行时能力模型影响。

## 📸 截图

| 深色 | 浅色 |
|---|---|
| ![NexusPilot 工作台（深色）](sites/product/public/screenshots/nexuspilot-workbench-dark.png) | ![NexusPilot 工作台（浅色）](sites/product/public/screenshots/nexuspilot-workbench-light.png) |

## 📦 安装

前往[官方下载页](https://nexuspilot.dev/releases)获取最新安装包。

| 平台 | 安装包 |
|---|---|
| Windows (x86_64) | NSIS 安装器（`.exe`） |
| macOS（Intel 与 Apple Silicon） | `.dmg` / `.app` |
| Linux (x86_64) | `.deb` / `.rpm` |

## 🚀 快速开始（开发）

环境要求：**Bun ≥ 1.3**（必须使用 Bun，不要用 pnpm/npm/yarn）与 **Rust toolchain**。

```bash
bun install

bun run dev:all         # 桌面应用 + AI Runtime 一起启动
# 或分别启动
bun run tauri dev       # Tauri 桌面应用（Vite，端口 1420）
bun run ai-runtime:dev  # 本地 AI Runtime 侧车（端口 8787）
```

### 提交前验证

```bash
bun run tsc --noEmit        # 前端类型检查
bun run ai-runtime:test     # AI Runtime 测试
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## 🧱 架构

| 层级 | 技术 |
|---|---|
| 前端 | React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui |
| 桌面壳 | Tauri v2 |
| 后端 | Rust · SQLite（元数据存储）· sqlx / redis / clickhouse 驱动 |
| AI Runtime | Bun · Elysia · Vercel AI SDK（本地侧车） |
| 状态管理 | Zustand · TanStack Query · React Router |

```text
Frontend (React)
  ├─ Workbench UI ── Tauri IPC ──► Rust 后端 ──► 数据库驱动
  └─ Agent UI ── /v1/runs · /health · /v1/events ──► AI Runtime ── AI SDK ──► LLM API

Rust 后端 ── WebSocket Bridge ◄──► AI Runtime（工具执行）
```

**AI Runtime** 是本地侧车，统一管理 provider/model 配置、Run 执行、历史与实时事件。LLM 凭据不会离开它；AI 数据库工具与你的界面共用同一个 Rust 连接运行时。

可选的 **NexusPilot Cloud** 连接同步是独立的商业服务，不影响本地数据库连接、查询或 AI Runtime 的独立使用。

> 请妥善保存 Recovery Key。如果所有已授权设备和 Recovery Key 同时丢失，Cloud 中的加密同步资产将无法恢复。

## 🤖 AI 提供商

NexusPilot 采用由用户自行配置提供商的模式。你可以在本地 AI Runtime 中选择支持的 provider 和 model，并通过应用内的提供商设置配置凭据。

- AI Runtime 会自动从 [models.dev](https://models.dev) 同步 provider/model 供应商目录，将元数据缓存在本地，并在后台进行刷新。
- 如果远程目录暂时不可用，仍会继续使用最近一次可用的本地目录；必要时也可以配置自定义 provider 和 model。
- LLM 凭据由本地 AI Runtime 管理，前端不会直接保存这些凭据。
- AI 请求会发送到你选择的模型提供商，并可能产生相应的使用费用。
- 数据库工具通过工作台连接运行时执行，并遵循能力限制和变更审批边界。
- 即使不启用 AI 功能或 NexusPilot Cloud，也可以独立使用数据库工作台。

## 📚 文档

- [官网](https://nexuspilot.dev) —— 产品介绍、下载入口与发布日志
- [文档](https://docs.nexuspilot.dev) —— 安装、快速开始、数据库连接与 AI 助手指南
- [公开权威知识库](./docs/README.md) —— 架构、契约、产品边界、ADR 与贡献者指南
- [架构概览](./docs/architecture/overview.md) —— 系统边界与组件职责
- [贡献者开发指南](./docs/development/README.md) —— 实现、测试、扩展与发布指引
- [契约](./docs/contracts/README.md) —— IPC 与 Desktop-to-Cloud 公共兼容边界
- [AGENTS.md](./AGENTS.md) —— 面向 AI 编码代理与贡献者的开发规范

## 🤝 参与贡献

欢迎参与贡献。进行代码修改前，请先阅读 [AGENTS.md](./AGENTS.md)，了解构建命令、代码风格、架构说明和 AI 协作规范。

提交 Pull Request 前，请运行上方验证命令，并避免提交凭据、私有连接字符串、生成产物或无关的内部文档。

## 🛡️ 安全

如果发现安全漏洞，请通过 **GitHub 私有漏洞报告**（Security 标签页）或邮件 `support@nexuspilot.dev` 私下报告。

请不要为安全漏洞创建公开 issue。报告中请尽量提供受影响版本、操作系统、复现步骤和影响范围。不要包含密码、访问令牌、完整连接字符串或敏感业务数据；请使用脱敏值或占位符替代。

## 📜 许可证

本项目采用 [Apache License 2.0](./LICENSE) 开源。

NexusPilot 与 NIEEX 为维护者商标，详见 [NOTICE](./NOTICE)。
