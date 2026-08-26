# AI Runtime sidecar lifecycle

Status: **Current**

This document defines the lifecycle of the local `ai-runtime` process used by the NexusPilot desktop application.

## Ownership

Tauri owns the production sidecar process. It resolves the packaged binary, creates a per-launch access token, starts the process, discovers its endpoint, monitors readiness, and terminates it during application shutdown or updater handoff.

The frontend never spawns the sidecar and never guesses its port. It obtains a sanitized endpoint from Tauri and uses the launch token only through the desktop runtime boundary.

## Development and production

| Mode | Process owner | Endpoint |
| --- | --- | --- |
| Development | repository scripts | loopback, port `8787` by default |
| Production | Tauri | loopback endpoint discovered for the packaged sidecar |

Development scripts may use a stable port for convenience. Production code must rely on endpoint discovery and must not assume that `8787` is available.

## Startup sequence

1. Tauri creates an unpredictable per-launch token.
2. Tauri starts the platform-specific `ai-runtime` binary with its data directory, host, port policy, and token supplied through process configuration.
3. The sidecar opens its Runtime Store and applies versioned migrations.
4. Tauri waits for a healthy response and exposes the sanitized endpoint to the frontend.
5. The Rust backend establishes the authenticated WebSocket bridge independently of frontend HTTP/SSE access.

Startup failures remain explicit. The workbench can continue to provide database functionality while AI features report the sidecar as unavailable.

## Authentication and exposure

- The server binds to loopback only.
- `/health` is a narrow process-health snapshot.
- Runtime APIs under `/v1/**`, SSE, and WebSocket upgrade paths require the per-launch token in production.
- Tokens, provider credentials, and database secrets must not appear in endpoint IPC responses, URLs, logs, or crash messages.
- CORS permits only the expected Vite loopback and Tauri application origins.

## Readiness and recovery

`GET /health` reports process readiness; it is not a bridge discovery or reconnect mechanism. Durable conversation and run recovery comes from the Runtime Store and Snapshot Read API. Live SSE events are disposable invalidation signals and cannot be used as the sole recovery source.

The backend bridge has its own ready, heartbeat, disconnect, and reconnect semantics as defined in [backend-bridge.md](./backend-bridge.md).

## Shutdown

Normal application exit, updater handoff, and fatal sidecar supervision all converge on explicit process termination. Shutdown should:

1. stop accepting new runs;
2. interrupt or settle active runs within a bounded period;
3. close the bridge and HTTP listeners;
4. close the Runtime Store;
5. terminate the process if graceful shutdown exceeds the bound.

Orphan processes must not survive application exit. Logs must identify lifecycle stages without printing launch tokens or provider credentials.

## Packaging

The production binary is packaged as a Tauri `externalBin` under `src-tauri/binaries/ai-runtime-<target-triple>[.exe]`. Builds must create the binary for the target platform before invoking the Tauri bundle step. The sidecar data directory is application-managed and never stored inside the installation directory.

## References

- [Communication boundaries](./communication-boundaries.md)
- [Backend bridge](./backend-bridge.md)
- [Runtime domain](./domain.md)
- [Network request boundaries](../architecture/network-boundaries.md)
