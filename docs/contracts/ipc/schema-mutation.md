# Schema and table mutation IPC

Status: **Current**

Schema and data changes use preview and execute boundaries. The complete payload definitions are consolidated in [overview.md](./overview.md).

## Generic schema mutation

Drivers that can represent their behavior losslessly through the common schema model expose explicit create, alter, rename, and drop capabilities. A preview returns a normalized plan, warnings, confirmation requirements, and a baseline identity. Execute accepts that plan boundary and repeats authorization and drift checks.

## Native schema extensions

Engine-native semantics that would be lost by the generic model use tagged native describe/create/change contracts. Native extensions:

- use closed target and operation enums rather than arbitrary JSON;
- require exact `schemaMutation` capability for the object and operation;
- bind canonical baseline, resource identity, support revision, and plan hash;
- re-read remote facts immediately before execution;
- fail closed for unsupported or unknown server semantics;
- distinguish schema application from asynchronous background data work.

ClickHouse table, projection, skipping-index, View, and Materialized View design is the reference native implementation. Physical HTTP session identifiers remain private to the Rust driver.

## Table row mutation

Table editing is authorized by driver capabilities, result-level source facts, column writability, and a valid row locator. Frontend change sets are untrusted input. Rust validates the real target, expected row identity, value types, affected-row bounds, transaction state, and remote drift before applying changes.

Previewed SQL is explanatory output, not an authorization token. Ambiguous outcomes preserve the local draft and require the user to refresh and verify remote state before retrying.
