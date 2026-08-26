# Contracts

Status: **Current / Frozen where noted**

Contracts define stable boundaries between processes, repositories, and independently deployed services. Implementations may add internal detail, but they must not silently change required fields, enum meanings, error behavior, cryptographic bytes, or authorization semantics described here.

| Document | Scope |
| --- | --- |
| [ipc/overview.md](./ipc/overview.md) | Consolidated Tauri IPC, structured errors, Engine metadata, SQL, schema, and table mutation contract. |
| [ipc/auth-and-cloud.md](./ipc/auth-and-cloud.md) | Sanitized Auth and Cloud IPC rules. |
| [ipc/engine.md](./ipc/engine.md) | Engine commands, capabilities, execution context, and managed SQL. |
| [ipc/schema-mutation.md](./ipc/schema-mutation.md) | Generic and native schema preview/execute boundaries. |
| [cloud-v1-client-api.md](./cloud-v1-client-api.md) | Frozen public Desktop-to-Cloud V1 API and cryptographic formats. |

The source types and generated schemas remain executable truth. If code and documentation disagree, fail closed, resolve the discrepancy, and update both in the same change.
