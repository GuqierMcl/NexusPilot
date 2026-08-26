# ADR 0001: Use Bun, Elysia, and the AI SDK for the local AI Runtime

## Status

Accepted

## Context

NexusPilot needs a local sidecar that owns model-provider configuration, credentials, agent execution, tool orchestration, persistent conversation state, and streaming. The desktop frontend must not hold provider secrets or call model APIs directly, and database tools must reuse the Rust connection runtime instead of creating a second set of database pools.

The project already uses TypeScript across the frontend and relies on the AI SDK protocol and ecosystem. A TypeScript runtime therefore reduces contract duplication between the sidecar and UI while keeping the security boundary as a separate local process.

## Decision

The production AI sidecar is `ai-runtime/`, implemented with:

- Bun as the JavaScript runtime and package manager;
- Elysia as the local HTTP and WebSocket server;
- the Vercel AI SDK for provider adapters and model execution;
- SQLite for runtime-owned durable state;
- a snapshot read API for recovery and a live-only event stream for transient UI updates;
- a WebSocket bridge to the Rust backend for authorized workbench tool execution.

The AI Runtime owns provider credentials, model resolution, runs, conversations, messages, tool snapshots, permission state, and continuation. The frontend owns presentation state. Rust owns database connections and execution.

## Consequences

- AI Runtime contracts and implementation use one TypeScript toolchain.
- The sidecar remains independently testable and restartable.
- Provider secrets stay outside the WebView.
- Runtime and frontend types still require explicit API compatibility rules; sharing a language does not make process boundaries implicit.
- Database tools require a stable bridge protocol and permission checks before reaching Rust.

## Alternatives considered

- Calling model providers directly from the frontend was rejected because it exposes credentials to the WebView and collapses the process boundary.
- Embedding all AI execution in Rust was rejected because it would give up the mature provider and streaming ecosystem used by the AI SDK.
- Giving the AI Runtime independent database connections was rejected because it would duplicate credentials, pools, transactions, and authorization semantics.

## References

- [AI Runtime design](../ai-runtime/README.md)
- [Communication boundaries](../ai-runtime/communication-boundaries.md)
- [Backend bridge](../ai-runtime/backend-bridge.md)
- [Network boundaries](../architecture/network-boundaries.md)
