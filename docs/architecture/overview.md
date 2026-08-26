# NexusPilot architecture

Status: **Current**

NexusPilot is an AI-native, cross-platform database workbench. The desktop application combines database connections, object browsing, query editing, data interaction, and an AI assistant while preserving explicit process and authorization boundaries.

## System map

```text
Frontend (React)
  ├─ Workbench UI ── Tauri IPC ──► Rust backend ──► database drivers
  └─ Agent UI
       ├─ HTTP + stream ─────────► local AI Runtime ──► selected LLM provider
       ├─ Snapshot Read API ─────► AI Runtime Store
       └─ live-only SSE ◄──────── AI Runtime EventBus

Rust backend
  └─ authenticated WebSocket Bridge ◄──► AI Runtime tool execution

Optional Cloud client
  └─ versioned HTTPS API ──────────────► NexusPilot Cloud
```

## Technology layers

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Frontend | React 19, TypeScript, Tailwind CSS v4, shadcn/ui | Workbench presentation and local UI state. |
| Desktop shell | Tauri v2 | Native process lifecycle, IPC, secure OS integrations, packaging, and updates. |
| Backend | Rust, SQLite, database driver crates | Profiles, metadata, connection runtimes, queries, mutations, and Cloud desktop client. |
| AI Runtime | Bun, Elysia, Vercel AI SDK, SQLite | Provider credentials, conversations, runs, tools, permissions, snapshots, and events. |
| Product site | Astro under `sites/product/` | Product website at `nexuspilot.dev`. |
| Documentation site | Astro/Starlight under `sites/docs/` | Renders only `docs/guides/` at `docs.nexuspilot.dev`. |

## Frontend boundary

The frontend is organized by product domain under `src/features/`. Zustand stores durable or cross-component UI state; TanStack Query owns server and IPC-derived state. React components do not become an alternative source of database, Cloud, or AI Runtime facts.

Workbench tabs carry stable identity in their payload, keep mutable tab state in the tab runtime store, and obtain remote data through query hooks. Explorer, toolbar, tab families, and driver configuration use registries so shared shells do not accumulate driver-specific branches.

The frontend:

- never stores LLM provider credentials;
- never owns database pools or physical session identifiers;
- never infers a write capability solely from a visible control;
- treats SSE and Tauri domain events as invalidation signals and restores facts through snapshots;
- uses `apiInvoke()` for structured Engine IPC errors.

## Rust workbench backend

The Rust backend is the authority for local profiles, database connections, and operations. `ConnectionRuntimeManager` and `DriverRegistry` provide one shared execution path for the UI and AI tools.

Drivers advertise `DriverCapabilities`. The frontend shows only operations declared by the driver and resource. Unknown or incomplete engine semantics remain read-only. Generic table operations use common contracts; engine-native behavior can use tagged native extensions when a generic schema would lose information.

Connection profiles, shared runtimes, tab-scoped runtimes, physical sessions, and remote metadata caches are deliberately separate concepts. See [database-runtime-session.md](./database-runtime-session.md) and [connection-runtime.md](./connection-runtime.md).

## Explorer and content model

The Explorer combines two domains:

- local configuration nodes such as folders, connections, and saved queries;
- lazily loaded remote containers such as databases, schemas, object groups, tables, views, and key-value namespaces.

Remote data is normalized into capability-driven `DataContainer` values. The shared tree renders the normalized model; driver contributors define engine-specific hierarchy and actions through registries. See [explorer-tree.md](./explorer-tree.md) and [explorer-actions.md](./explorer-actions.md).

## IPC and error boundary

Storage CRUD may use internal `AppResult`/string errors where it is not exposed as an Engine contract. Database Engine commands use `IpcResult<T>` and structured `IpcError` values with stable codes, a user-facing message, and sanitized details. The frontend consumes Engine commands through `apiInvoke()`.

The consolidated protocol and focused domain summaries live under [contracts](../contracts/README.md).

## AI Runtime boundary

The local AI Runtime owns provider/model configuration, credentials, agent modes, conversations, runs, messages, tool snapshots, permission state, and runtime persistence. It uses three distinct channels:

| Channel | Purpose |
| --- | --- |
| Frontend HTTP/stream and Snapshot APIs | Start runs, render the active response, and recover durable state. |
| Frontend SSE | Disposable invalidation and UI coordination events. |
| Rust backend WebSocket bridge | Authenticated command/response transport for workbench tools. |

The frontend does not connect to the backend bridge, and Rust does not use SSE or `/health` for bridge discovery. AI tools reach databases only through the same Rust connection runtime used by the workbench. See [AI Runtime](../ai-runtime/README.md).

## Account and Cloud boundary

Account authentication is optional and provider-neutral at the desktop boundary. Tokens and long-lived authentication material are managed through Rust and the system credential store; the WebView receives only sanitized account state.

NexusPilot Cloud is optional. Local database connections, queries, and AI Runtime use do not require Cloud. When enabled explicitly, the desktop encrypts connection assets before upload, keeps device private keys in the operating-system credential store, and treats Cloud responses as the authority for subscription, entitlement, quota, lifecycle, and device status. See [account-authentication.md](./account-authentication.md), [cloud-integration.md](./cloud-integration.md), and [ADR 0003](../adr/0003-cloud-sync-cryptography-and-explicit-enablement.md).

## Public sites and release data

The product website and documentation renderer are independent applications. Neither site imports the other's private source tree. The documentation renderer reads only `docs/guides/` through an allowlist. See [sites-and-documentation.md](./sites-and-documentation.md).

Release metadata is a public, versioned data boundary shared by the website, documentation, updater, and release workflow. Published metadata must not depend on reading repository internals at site-build time. See [release-distribution.md](./release-distribution.md).

## Authoritative follow-up documents

- [Architecture index](./README.md)
- [Contracts](../contracts/README.md)
- [AI Runtime](../ai-runtime/README.md)
- [Contributor development guides](../development/README.md)
- [Architecture decisions](../adr/README.md)
- [Product intent](../product/README.md)
