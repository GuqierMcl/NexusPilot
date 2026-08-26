# Engine IPC

Status: **Current**

Engine IPC exposes database capabilities through structured commands and `IpcResult<T>`. The complete field-level consolidated contract is [overview.md](./overview.md).

## Error shape

Engine failures use a stable error object:

```ts
interface IpcError {
  code: string;
  message: string;
  details?: unknown;
}
```

The frontend calls Engine commands through `apiInvoke()`, which maps known error codes to common presentation while allowing domain code to handle specific failures silently when required. Details must be sanitized and must not contain credentials or full connection payloads.

## Capabilities and containers

Drivers return a `DriverCapabilities` snapshot and generic `DataContainer` metadata. The frontend renders declared object and operation capabilities rather than deriving write access from the driver name.

Unknown object semantics, incomplete metadata, unsupported server versions, or missing privileges stay read-only. Driver and resource capabilities are rechecked by Rust at execution time.

## Connection and execution context

Commands identify a profile and, where required, a logical tab runtime. Physical pool handles and session IDs never cross IPC. SQL execution context uses structured database/schema values; the frontend does not prepend hidden context-changing SQL to the user's statement.

## SQL execution

Drivers may expose the basic `execute_sql` contract or a managed lifecycle with start, progress, interruption, and artifact handling. Managed support is explicit capability, not a frontend inference. Query results carry column metadata, writable-source facts, and row-locator information required by downstream table operations.

## Installation identity

The read-only installation identity distinguishes a local installation and supports updater/product behavior. It is not an account, authentication credential, device proof, analytics consent, or Cloud device ID.
