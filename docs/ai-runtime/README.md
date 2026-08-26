# AI Runtime

Status: **Current**

`ai-runtime/` is NexusPilot's local AI execution boundary. It owns provider and model configuration, LLM credentials, conversations, runs, tool orchestration, permission continuation, persistent Runtime state, and live notifications. The frontend owns presentation; the Rust backend owns database connections and workbench operations.

## Core boundaries

- Provider credentials never enter the frontend.
- AI database tools reuse the Rust connection runtime through the authenticated backend bridge.
- Runtime Store and Snapshot Read APIs are the durable facts; SSE is a live-only invalidation channel.
- Each run resolves an immutable tool snapshot from the selected agent mode, model capabilities, runtime settings, and registered tools.
- Tool visibility is not authorization. Risk analysis, permission state, prepared plans, and backend checks still apply at execution time.

## Documentation map

| Document | Authority |
| --- | --- |
| [domain.md](./domain.md) | Domain objects, Runtime SQLite storage, migrations, and projections. |
| [runner-core.md](./runner-core.md) | Run execution, streaming, persistence, and failure semantics. |
| [run-lifecycle-interrupt.md](./run-lifecycle-interrupt.md) | Run states, interruption, and partial output. |
| [agent-definition.md](./agent-definition.md) | Agent modes, prompt assembly, and tool policy inputs. |
| [tool-namespace.md](./tool-namespace.md) | Tool naming, registry, snapshots, codecs, and dispatch. |
| [tool-permission.md](./tool-permission.md) | Approval, strong confirmation, and same-run continuation. |
| [database-tools.md](./database-tools.md) | Stable safety rules for SQL and key-value tools. |
| [settings.md](./settings.md) | Runtime-owned settings and per-run freezing. |
| [provider-model.md](./provider-model.md) | models.dev catalog, provider configuration, credentials, and model resolution. |
| [live-eventbus-sse.md](./live-eventbus-sse.md) | Live-only EventBus and scoped SSE. |
| [communication-boundaries.md](./communication-boundaries.md) | Frontend HTTP/SSE, backend bridge, and health responsibilities. |
| [backend-bridge.md](./backend-bridge.md) | Authenticated WebSocket transport and Rust Gateway. |
| [sidecar-lifecycle.md](./sidecar-lifecycle.md) | Startup, discovery, authentication, packaging, and shutdown. |

## API conventions

The sidecar is a focused local service and does not use an `/api` prefix:

- process health: `GET /health`;
- versioned runtime resources: `/v1/**`;
- run creation: `POST /v1/runs`;
- history and recovery: Snapshot Read APIs under `/v1/**`;
- live invalidation events: `GET /v1/events`;
- backend capability transport: authenticated WebSocket bridge.

Run requests select a model and agent mode, and provide typed input parts. They do not accept caller-controlled system prompts, tool registries, execution limits, or provider credentials.

## AI SDK documentation rule

Before changing `ai` or `@ai-sdk/*` behavior, consult the current [AI SDK documentation index](https://ai-sdk.dev/llms.txt) and the relevant API pages. Repository design documents describe NexusPilot's invariants; the upstream documentation defines the supported SDK surface.
