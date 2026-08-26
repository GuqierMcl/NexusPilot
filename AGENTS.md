# AGENTS.md - Agent Coding Guidelines for NexusPilot

本文件为 AI 编码代理（Copilot coding agent、Codex、Claude Code 等）在本仓库工作时提供行为指南。

---

## 项目定位

**NexusPilot 是一个 AI 原生的跨平台多数据库桌面工作台** —— "用自然语言和你的数据库对话"。

面向开发者和数据团队的专业数据工作台，把多源连接、结构浏览、查询编辑和 AI 辅助分析整合到一个高效的桌面环境。

### 核心特性

1. **驾驭每一种数据形态**：在同一桌面工作区连接并管理持续扩展的关系型、键值型、分析型数据源（当前：PostgreSQL、MySQL、Redis、Oracle、SQLite、ClickHouse）；按各自特性浏览对象、查看数据并完成日常操作，而不是把所有引擎塞进同一种表格界面。
2. **让 AI 成为懂数据的副驾**：AI 助手基于已打开的连接、真实的对象结构与查询结果协助探索、生成 SQL 和分析数据；它通过受限工具访问工作台，而不是凭空猜测数据库。
3. **每一次变更，都经得起验证**：AI 发起的 SQL 与 Redis 写操作都要经过风险分析和审批；支持预览的表格与原生结构变更会在执行前展示计划，并在关键变更时核对远端状态。
4. **尊重每个引擎的原生表达**：以能力模型（capability）呈现各引擎真正支持的操作，对未知语义保持只读。
5. **从连接到洞察，一气呵成**：连接树 → 数据库对象 → 带上下文的 SQL 标签页 → 数据网格或 AI 对话，连接状态、标签页和运行结果围绕同一个工作区协同。
6. **安全，从边界开始**：原生桌面应用承载数据库连接；独立的本地 AI Runtime 管理模型与提供商配置，前端不直接保存或调用 LLM 凭据。

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui |
| 桌面应用 | Tauri v2 |
| 后端 | Rust + SQLite（元数据存储） |
| AI Runtime | Bun + Elysia + Vercel AI SDK（本地 sidecar） |
| 状态管理 | Zustand + TanStack Query + React Router |
| 包管理器 | Bun（前端/AI Runtime）· Cargo（Rust） |

---

## 1. Build, Test & Lint Commands

### Frontend (React 19 + TypeScript + Vite)

```bash
# Install dependencies (Bun is required - not pnpm/npm/yarn)
bun install

# Start Vite dev server (port 1420)
bun run dev

# Build frontend (runs tsc + vite build)
bun run build

# Type-check only (routine verification)
bun run tsc --noEmit
```

### AI Runtime Sidecar (Bun + Elysia)

```bash
# Start AI Runtime dev server (port 8787)
bun run ai-runtime:dev

# Run AI Runtime tests
bun run ai-runtime:test

# Type-check AI Runtime
bun run ai-runtime:typecheck

# Build AI Runtime sidecar binary
bun run ai-runtime:build
```

### Desktop App (Tauri v2)

```bash
# Full desktop dev (Vite + Tauri)
bun run tauri dev

# Production build
bun run tauri build
```

### Rust Backend

```bash
# Build Rust backend only
cd src-tauri && cargo build

# Run all Rust tests
cd src-tauri && cargo test

# Check formatting
cd src-tauri && cargo fmt --check

# Lint (clippy)
cd src-tauri && cargo clippy -- -D warnings
```

### Test Status

- 前端常规验证：`bun run tsc --noEmit`
- Rust 单元测试：`cd src-tauri && cargo test`
- AI Runtime：`bun run ai-runtime:test`
- 真实数据库集成测试见 `tests/` 与 `.env.test.example` 的配置说明

---

## 2. Code Style Guidelines

### General

- **Package manager**: Always use `bun`, never pnpm/npm/yarn for JavaScript or TypeScript package operations.

### Imports & Path Aliases

- Use path alias `@/` for internal modules (maps to `src/`)
- Order imports: external libs → internal aliased imports → relative imports

### TypeScript Conventions

- Use explicit types for function parameters and return types
- Use `type` for type aliases, interfaces for object shapes
- Prefer `interface` over `type` for component props
- Use camelCase for API boundaries (Rust uses `#[serde(rename_all = "camelCase")]`)

### React & Component Patterns

- Use functional components with explicit `FC` types for exported components
- Extract reusable menu groups/components in explorer patterns instead of large inline menu logic
- Use `tailwind-merge` and `clsx` utilities for combining Tailwind classes
- Use `class-variance-authority` (cva) for component variants

### Naming Conventions

- **Files**: kebab-case (e.g., `connection-folder.ts`)
- **Components**: PascalCase (e.g., `ConnectionTree.tsx`)
- **Hooks**: camelCase with `use` prefix (e.g., `useConnections`)
- **Utils**: camelCase (e.g., `buildExplorerTree.ts`)
- **Rust functions**: snake_case (e.g., `list_connection_folders`)

### FE/BE Contract Sync

- TS types in `src/types/` must mirror Rust enums/structs
- IPC contract types live behind `src/types/ipc.ts` and are split by domain in `src/types/ipc/`
- Keep both sides in sync when adding new driver types

### Error Handling

- **Rust (Engine commands)**: Use `IpcResult<T>` returning structured `IpcError { code, message, details }`
  - Error codes: `AUTH_FAILED`, `NETWORK_TIMEOUT`, `QUERY_SYNTAX_ERROR`, `RESOURCE_NOT_FOUND`, `SYSTEM_INTERNAL`, `OPERATION_CANCELED`
  - See `src-tauri/src/error.rs` for helper constructors
- **Rust (Storage commands)**: SQLite CRUD uses `AppResult<T>` (internal only, not exposed to frontend)
- **Frontend**: Use `apiInvoke()` from `lib/api-client.ts` - automatically shows toast errors via sonner
  - Pass `{ silent: true }` as third argument to handle errors manually
  - Access `error.code` for branch logic (e.g., `AUTH_FAILED` → highlight password field)
- Always log context via `console.error` in catch blocks for debugging

### Tailwind CSS v4

- Use Tailwind v4 syntax (no @apply, no config file for most cases)
- Use arbitrary values sparingly
- Leverage CSS variables for theming via `next-themes`

---

## 3. Architecture Overview

### Frontend Structure (`src/`)

```
src/
├── features/workbench/              # Main DB workbench
│   ├── explorer/                    # Connection tree, folders, context menus, per-driver configs
│   ├── content/                     # Tabs, SQL editor, data grids, table/view designers
│   └── agent/                       # AI agent panel (status-bar / conversation / input)
├── features/account/                # Optional OIDC account UI
├── components/                      # AppLayout, NavigationRail, AppTitleBar, Monaco wrapper, shadcn/ui
├── store/slices/                    # Zustand stores
├── hooks/queries/                   # TanStack Query hooks
├── lib/                             # tauri IPC wrappers, api-client, query-keys
├── routes/                          # React Router pages
└── types/                           # Shared types incl. ipc/ contract modules
```

### Rust Backend (`src-tauri/src/`)

```
src-tauri/src/
├── commands/                        # Tauri command handlers (connections, folders, engine)
├── engine/                          # Connection engine: driver traits, concrete drivers, manager, registry
├── auth/                            # Provider-neutral OIDC authentication
├── ai_runtime/                      # AI Runtime sidecar lifecycle + backend WebSocket bridge/gateway
├── cloud/                           # E2EE connection-sync client (talks to the cloud service)
├── repository/                      # SQLite repositories using sqlx
├── db/                              # SQLite init + migrations
└── error.rs                         # AppError (internal) + IpcError (frontend-facing)
```

### AI Runtime Sidecar (`ai-runtime/`)

Bun + Elysia sidecar process. It owns provider/model configuration, Run execution, AI SDK-compatible streaming, a runtime SQLite store, a Snapshot Read API, and live-only SSE/EventBus.

```
ai-runtime/
├── src/
│   ├── app.ts                 # Elysia app composition and route registration
│   ├── config.ts              # host/port/data-dir configuration
│   ├── provider/              # catalog, provider service, AI SDK language model resolver
│   ├── routes/                # health, providers, runs, conversations, history, settings, events
│   ├── runtime/               # domain model, runners, agents, tools, projections, store, events
│   └── storage/               # runtime SQLite open/migration manager/migrations
├── tests/                     # Bun test suite
└── package.json
```

### Key Patterns

- **Explorer tree**: Local connection/folder nodes derived by `buildExplorerTree()`; connected remote metadata lazy-loaded via `list_containers` and converted by `buildRemoteNodes()`. Backend returns `DataContainer` with generic `asset_group` nodes (tables, views, routines, indexes, Redis namespaces, ...).
- **Capability-driven drivers**: `DriverCapabilities` declares what a driver can do (`schemaBrowser`, `dataTableBrowser`, `sqlExecutor`, `tableRowMutator`, ...). UI renders only registered capabilities; unknown semantics stay read-only.
- **Two-layer error system**: Storage layer uses internal errors; Engine layer uses structured `IpcError` consumed via `apiInvoke()`.
- **State management**: Zustand for UI state (tabs, layout, connection sessions); TanStack Query for server state (databases, tables, query results).
- **Connection session flow**: Double-click connection node → `connectionSessionStore.connect(profileId)` → `connect_profile` IPC → lazy-loaded metadata when `status === "connected"`.
- **Registry-based extension points**: Workbench explorer/toolbar/tab families converge on registries instead of centralized per-type branching (see `src/features/workbench/`).

### Communication Model

```text
Frontend (React)
  ├─ Workbench UI ── Tauri IPC ──► Rust backend ──► database drivers
  └─ Agent UI
       ├─ GET /health ─────────────────► AI Runtime health snapshot
       ├─ POST /v1/runs ───────────────► AI Runtime ── AI SDK adapters ──► LLM API
       ├─ Snapshot Read API ───────────► AI Runtime Store (history recovery)
       └─ GET /v1/events ◄────────────── AI Runtime live-only EventBus

Rust backend
  └─ WebSocket Bridge client ◄──► AI Runtime Backend Bridge (tool execution)
```

- The frontend must not own LLM credentials or call LLM APIs directly.
- The AI Runtime owns all LLM credentials and provider/model configuration.
- AI database tools execute through the same Rust connection runtime (no separate pools).

---

## 4. Contribution Guidelines

- Public web applications are split into `sites/product/` (the product website at `nexuspilot.dev`) and `sites/docs/` (the Starlight documentation renderer at `docs.nexuspilot.dev`). They must build independently and must not import each other's source files.
- `docs/README.md` is the public knowledge entry point. `docs/guides/` is the only documentation-site content source; `docs/development/` contains contributor implementation guides; `docs/architecture/` describes current system facts; `docs/contracts/` defines stable or frozen protocols; `docs/ai-runtime/` owns Runtime design; and `docs/adr/` records accepted decisions.
- The `sites/docs/` application loads only `docs/guides/**/*.{md,mdx}` through Astro's Content Loader. Do not create a second Markdown source tree inside the site package and do not widen the loader to scan all of `docs/`.
- Personal AI plans, prompts, transcripts, worklogs, private design diaries, and scratch records must not be committed. Rewrite reusable conclusions into the appropriate authoritative document instead of copying collaboration records; `docs/superpowers/` is explicitly excluded.
- User behavior changes must update `docs/guides/` when externally visible. Architecture, contract, AI Runtime, and contributor-workflow changes must update their authoritative documents in the same pull request.
- Before changing AI SDK (`ai` / `@ai-sdk/*`) behavior, consult the official AI SDK docs: <https://ai-sdk.dev/llms.txt>
- When adding a new database driver:
  - Frontend: update `DbDriver`, add payload interface, register `driver-configs/`, sync IPC metadata types
  - Rust storage: extend `ConnectionDriver` in `repository/connection_repository.rs`
  - Rust engine: add `DriverProfile`, concrete driver implementation, and `DriverRegistry` factory branch
- Engine IPC must go through `apiInvoke()` (not raw `invoke`) for proper error toasts.
- See `CONTRIBUTING.md` for the development setup and PR workflow.

### Documentation entry points

- Public knowledge base: `docs/README.md`
- Current architecture: `docs/architecture/overview.md`
- Stable contracts: `docs/contracts/README.md`
- AI Runtime design: `docs/ai-runtime/README.md`
- Contributor implementation guides: `docs/development/README.md`
- Product intent and support boundaries: `docs/product/README.md`

### Commit Convention

Use the Conventional Commits structure. Commit subjects should be written in
English by default so they are accessible to the broader community. Chinese
subjects are also accepted when they communicate the change more clearly.

```text
<type>(<scope>): <English summary>

- <English detail 1>
- <English detail 2>
```

- `type`: use an English Conventional Commit type such as `feat`, `fix`, `docs`, `test`, `refactor`, or `chore`.
- `scope`: use an English module name such as `ai-runtime`, `editor`, `settings`, or `table-designer`.
- Summary: describe the concrete outcome and avoid vague wording such as "update" or "change" without context. English is the default; Chinese is supported.
- Non-trivial commits must include a bullet-list body. Keep the body in the same language as the summary when practical.
