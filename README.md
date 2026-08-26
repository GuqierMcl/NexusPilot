<p align="center">
  <img src="sites/product/public/logo.svg" alt="NexusPilot" width="120" />
</p>

<h1 align="center">NexusPilot</h1>

<p align="center">
  <b>Talk to your databases in natural language.</b><br/>
  An AI-native, cross-platform database workbench for developers and data teams.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/Tauri-2.0-4B5563.svg" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/React-19-61DAFB.svg" alt="React 19" />
  <img src="https://img.shields.io/badge/Rust-2021-000000.svg" alt="Rust" />
  <img src="https://img.shields.io/badge/AI%20Runtime-Bun%20%2B%20Elysia-000000.svg" alt="AI Runtime: Bun + Elysia" />
</p>

English | [简体中文](./README.zh-CN.md)

**NexusPilot** brings multi-source connections, structure browsing, query editing, and AI-assisted analysis into one efficient desktop environment. It is built on **Tauri v2**, **React 19**, and **Rust**, with a local **AI Runtime** sidecar powered by **Bun + Elysia + the Vercel AI SDK**.

---

## ✨ Features

- **Every data shape, one workbench** — connect to relational, key-value, and analytics engines and interact with each one the way its engine actually works, instead of forcing everything into a single table UI.
- **An AI copilot that knows your data** — the assistant explores, writes SQL, and analyzes based on the connections you have open, real object structures, and real query results. It reaches the workbench through restricted tools, not guesses.
- **Changes you can verify** — AI-initiated SQL and Redis writes pass risk analysis and approval; table and native schema changes show previews before execution and re-check remote state for critical operations.
- **Capability-driven, engine-native** — NexusPilot adapts to the capabilities of each database engine and stays read-only when a semantic is unknown or cannot be verified safely.
- **From connection to insight** — drill from the connection tree into database objects, run and save queries in context-aware SQL tabs, and continue in the data grid or AI conversation — all in one workspace.
- **Security from the boundary** — the native desktop app owns your database connections; a separate local AI Runtime owns all LLM credentials. The frontend never holds or calls LLM APIs directly.
- **NexusPilot Cloud** — sync saved connections and folders across authorized devices with end-to-end encryption, device authorization, and Recovery Key recovery. Cloud stores encrypted assets rather than plaintext connection credentials, and the desktop workbench remains fully usable without Cloud.

## 🗄️ Supported Databases

| Database | Status |
|---|---|
| **PostgreSQL** | ✅ Supported |
| **MySQL** | ✅ Supported |
| **SQLite** | ✅ Supported |
| **Redis** | ✅ Supported |
| **ClickHouse** | ✅ Supported |
| **Oracle** | ✅ Supported |

> This table lists supported connection drivers. Available operations may vary by database engine, server version, permissions, and the capability model reported at runtime.

## 📸 Screenshots

| Dark | Light |
|---|---|
| ![NexusPilot workbench (dark)](sites/product/public/screenshots/nexuspilot-workbench-dark.png) | ![NexusPilot workbench (light)](sites/product/public/screenshots/nexuspilot-workbench-light.png) |

## 📦 Installation

Download the latest installer from the [official release page](https://nexuspilot.dev/releases).

| Platform | Package |
|---|---|
| Windows (x86_64) | NSIS installer (`.exe`) |
| macOS (Intel & Apple Silicon) | `.dmg` / `.app` |
| Linux (x86_64) | `.deb` / `.rpm` |

## 🚀 Quick Start (development)

Prerequisites: **Bun ≥ 1.3** (required — not pnpm/npm/yarn) and a **Rust toolchain**.

```bash
bun install

bun run dev:all         # desktop app + AI Runtime together
# or individually
bun run tauri dev       # Tauri desktop app (Vite on port 1420)
bun run ai-runtime:dev  # local AI Runtime sidecar (port 8787)
```

### Verify before submitting

```bash
bun run tsc --noEmit        # frontend type-check
bun run ai-runtime:test     # AI Runtime tests
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## 🧱 Architecture

| Layer | Tech |
|---|---|
| Frontend | React 19 · TypeScript · Tailwind CSS v4 · shadcn/ui |
| Desktop shell | Tauri v2 |
| Backend | Rust · SQLite (metadata) · sqlx / redis / clickhouse drivers |
| AI Runtime | Bun · Elysia · Vercel AI SDK (local sidecar) |
| State | Zustand · TanStack Query · React Router |

```text
Frontend (React)
  ├─ Workbench UI ── Tauri IPC ──► Rust backend ──► database drivers
  └─ Agent UI ── /v1/runs · /health · /v1/events ──► AI Runtime ── AI SDK ──► LLM APIs

Rust backend ── WebSocket Bridge ◄──► AI Runtime (tool execution)
```

The **AI Runtime** is a local sidecar that owns provider/model configuration, run execution, history, and live events. LLM credentials never leave it, and AI database tools execute through the same Rust connection runtime your UI uses.

Optional **NexusPilot Cloud** connection sync is a separate, commercial service. It is not required for local database connections, queries, or the AI Runtime.

> Keep your Recovery Key safe. If all authorized devices and the Recovery Key are lost, encrypted Cloud sync assets cannot be recovered.

## 🤖 AI Providers

NexusPilot uses a bring-your-own-provider model. Configure a supported provider and model in the local AI Runtime, then provide credentials through the app's provider settings.

- The AI Runtime automatically synchronizes the provider and model catalog from [models.dev](https://models.dev), caches the metadata locally, and refreshes it in the background.
- If the remote catalog is temporarily unavailable, the last usable local catalog remains available; custom providers and models can also be configured when needed.
- LLM credentials are managed by the local AI Runtime and are not stored in the frontend.
- AI requests are sent to the provider selected by you and may incur provider usage costs.
- Database tools operate through the workbench connection runtime and use explicit capability and approval boundaries for changes.
- You can use the database workbench without enabling AI features or NexusPilot Cloud.

## 📚 Documentation

- [Website](https://nexuspilot.dev) — product overview, downloads, and release history
- [Documentation](https://docs.nexuspilot.dev) — installation, quick start, database connections, and AI assistant guides
- [Public knowledge base](./docs/README.md) — authoritative architecture, contracts, product intent, ADRs, and contributor guides
- [Architecture overview](./docs/architecture/overview.md) — system boundaries and component ownership
- [Contributor development guides](./docs/development/README.md) — implementation, testing, extension, and release guidance
- [Contracts](./docs/contracts/README.md) — IPC and public Desktop-to-Cloud compatibility boundaries
- [AGENTS.md](./AGENTS.md) — coding guidelines for AI agents and contributors

## 🤝 Contributing

Contributions are welcome. Please read [AGENTS.md](./AGENTS.md) for build commands, code style, architecture notes, and AI-assisted development conventions before making changes.

Before opening a pull request, run the verification commands above and avoid including credentials, private connection strings, generated artifacts, or unrelated internal documents.

## 🛡️ Security

If you discover a security vulnerability, please report it privately through **GitHub private vulnerability reporting** (the Security tab) or by email at `support@nexuspilot.dev`.

Please do not open public issues for security vulnerabilities. When reporting a security issue, include the affected version, operating system, reproduction steps, and impact where possible. Do not include passwords, access tokens, full connection strings, or sensitive business data in the report; redact or replace them with placeholders.

## 📜 License

Licensed under the [Apache License, Version 2.0](./LICENSE).

NexusPilot and NIEEX are trademarks of the maintainer; see [NOTICE](./NOTICE).
