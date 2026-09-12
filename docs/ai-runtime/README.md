# AI Runtime

Status: **Current**

`ai-runtime/` is NexusPilot's local AI execution boundary. It owns provider and model configuration, LLM credentials, conversations, runs, tool orchestration, permission continuation, persistent Runtime state, and live notifications. The frontend owns presentation; the Rust backend owns database connections and workbench operations.

## Core boundaries

- Provider credentials never enter the frontend.
- AI database tools reuse the Rust connection runtime through the authenticated backend bridge.
- Runtime Store and Snapshot Read APIs are the durable facts; SSE is a live-only invalidation channel.
- Each run resolves an immutable tool snapshot from the selected agent mode, model capabilities, runtime settings, and registered tools.
- Tool visibility is not authorization. Risk analysis, permission state, prepared plans, and backend checks still apply at execution time.
- Chat attachments are uploaded through dedicated authenticated endpoints, persisted under Runtime `dataDir`, and referenced by final `att_*` IDs. `/v1/runs` never uploads files or accepts file bytes, paths, URLs, or upload-session IDs.
- Runtime projects persisted attachment bytes to AI SDK standard `file` parts without using provider/model catalog capabilities as an attachment gate.
- Conversation history is append-only: the Audit Transcript retains every branch, while the default UI and model history use the Conversation's active Run lineage.
- Context planning is a derived, request-scoped view evaluated before every model request: deterministic Safety State plus either full raw active history or a compatible Run/sealed-step checkpoint and exact raw suffix. Checkpoints never replace audit history.
- Compaction lifecycle is a durable, independently ordered `ContextCompactionActivity`; `preparing/created/failed/recovered/interrupted` appears at the real request boundary and never enters the Provider prompt.
- Manual `/compact` uses a persisted conversation operation and the same checkpoint service; it allocates an unused context slot on a terminal head without creating chat messages. `/explain` persists a short command binding and a Runtime-owned prompt snapshot; only the model projection expands that snapshot. See [composer-references.md](./composer-references.md).
- `Run.usage` is cumulative billing usage. Request-scoped `ContextUsage` retains each request estimate and Provider observation, while its durable `nextTurnForecast` powers the primary context-window display after a run finishes.

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
| [attachment-storage.md](./attachment-storage.md) | Current Runtime-owned chat attachment storage, upload, lifecycle, and multimodal model-input contract. |
| [composer-references.md](./composer-references.md) | Typed composer references, local commands, extension registries, persistence, projections, and failure recovery. |
| [active-tab-context.md](./active-tab-context.md) | Selected-tab metadata and SQL editor content snapshots, draft controls, native data parts, registration and model context. |
| [Context-compaction specification](../comet/specs/agent-context-compaction/spec.md) | Binding current behavior for branch-aware context planning, checkpoints, Safety State, and overflow recovery. |
| [live-eventbus-sse.md](./live-eventbus-sse.md) | Live-only EventBus and scoped SSE. |
| [communication-boundaries.md](./communication-boundaries.md) | Frontend HTTP/SSE, backend bridge, and health responsibilities. |
| [backend-bridge.md](./backend-bridge.md) | Authenticated WebSocket transport and Rust Gateway. |
| [sidecar-lifecycle.md](./sidecar-lifecycle.md) | Startup, discovery, authentication, packaging, and shutdown. |

## API conventions

The sidecar is a focused local service and does not use an `/api` prefix:

- process health: `GET /health`;
- versioned runtime resources: `/v1/**`;
- run creation and control: `POST /v1/runs`, `POST /v1/runs/:runId/continue`, and `POST /v1/runs/:runId/interrupt`;
- conversations: `/v1/conversations/**`, including messages, per-conversation runs, and manual compaction operations (`/v1/conversations/:conversationId/compactions`);
- provider and model configuration: `/v1/providers/**`, `/v1/models/available`, `/v1/custom-providers/**`, and `/v1/catalog/**`;
- agent modes and Runtime settings: `GET /v1/agent-modes` and `GET/PUT /v1/settings`;
- attachment upload: `POST/PUT/GET/DELETE /v1/attachment-uploads`;
- attachment metadata and authenticated content: `GET/DELETE /v1/attachments/:attachmentId` and `GET /v1/attachments/:attachmentId/content`;
- history and recovery: Snapshot Read APIs under `/v1/**` (runs, run events, run traces, permissions, and tool approvals);
- live invalidation events: `GET /v1/events`;
- backend capability transport: authenticated WebSocket bridge.

Run requests select a model and agent mode, and provide typed input parts. They do not accept caller-controlled system prompts, tool registries, execution limits, or provider credentials.

The message-history endpoint defaults to the active lineage and includes the active head/revision. `view=transcript` is the explicit audit/diagnostic view and includes sanitized Run DAG relationships. The Runtime currently exposes no branch-browsing interface. Manual `/compact` is a user-facing conversation operation served by dedicated endpoints (`POST/GET /v1/conversations/:conversationId/compactions` and `POST /v1/conversations/:conversationId/compactions/:operationId/cancel`); they drive the same checkpoint service through the internal `manual` trigger so every entry point stays on the same safe orchestration path. See [composer-references.md](./composer-references.md).

## AI SDK documentation rule

Before changing `ai` or `@ai-sdk/*` behavior, consult the current [AI SDK documentation index](https://ai-sdk.dev/llms.txt) and the relevant API pages. Repository design documents describe NexusPilot's invariants; the upstream documentation defines the supported SDK surface.
