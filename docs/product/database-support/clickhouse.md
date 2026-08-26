# ClickHouse support

Status: **Current**

NexusPilot supports a single-node ClickHouse workbench over HTTP. The implementation preserves ClickHouse-native concepts rather than pretending the engine has ordinary relational transaction and schema semantics.

## Current baseline

- connection profiles, connection testing, runtime state, and single-node HTTP execution;
- database and object browsing for tables, views, materialized views, columns, projections, and data-skipping indexes;
- DataTable browsing with bounded pagination and ClickHouse type metadata;
- SQL execution with query IDs, progress, interruption, managed scripts, and raw artifact export where supported;
- native Database, Table, Column, Projection, Index, View, and Materialized View design operations through typed preview/execute contracts;
- Local and tab-scoped Temporary View workflows;
- basic DataTable insert, update, and delete for supported ordinary Local table shapes.

## Safety model

ClickHouse keeps `schemaMutator=false` and uses the native schema extension. Every mutation requires the exact object/operation capability, a canonical baseline, drift checks, and post-execution proof. Unknown catalog semantics remain visible but read-only.

DataTable writes use resource and column capabilities. Update and delete locate rows through an original row snapshot, prove a single match before sending a mutation, and verify the remote result afterward. Sorting and primary keys are not treated as guaranteed unique identifiers. Ambiguous outcomes preserve the draft and instruct the user to refresh rather than retry automatically.

Temporary Views use a backend-only HTTP session tied to the owning SQL tab. The physical `session_id` never enters IPC, logs, profiles, frontend state, or persistence.

## Explicitly deferred

- ClickHouse Cloud and generalized HTTPS/TLS, domain/SNI, SSH, or Native TCP compatibility claims;
- multi-node Cluster execution, `ON CLUSTER`, Replicated/Distributed write behavior, and Keeper administration;
- full low-privilege compatibility matrices;
- complete complex-type editing and bulk import/export;
- traditional transaction promises;
- mutation/background-operation center and advanced query diagnostics.

These items are not implied by the general “Supported” label. The application continues to gate behavior through runtime capabilities.

## Implementation references

- [ClickHouse table designer](../../development/clickhouse-table-designer.md)
- [ClickHouse view designer](../../development/clickhouse-view-designer.md)
- [Native schema mutation contract](../../contracts/ipc/schema-mutation.md)
- [Database runtime sessions](../../architecture/database-runtime-session.md)
