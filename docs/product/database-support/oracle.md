# Oracle support

Status: **Current**

NexusPilot provides an open-box Oracle workbench path using the Rust Oracle driver stack, without requiring users to install Oracle Instant Client for the supported baseline.

## Current baseline

- host/port connections using service name, SID, or supported EZConnect input;
- connection testing, shared and tab-scoped runtimes, and optional SSH routing;
- Explorer hierarchy from connection directly to owner/schema, then object groups;
- browsing tables, views, materialized views, routines, indexes, triggers, sequences, columns, and paged data;
- SQL editor execution with explicit schema context;
- ordinary-table DataTable insert, update, and delete using a complete primary key;
- tab-scoped DataTable transactions with commit and rollback;
- ordinary-table designer support for describe, create, common alter operations, destructive confirmation, and remote drift detection.

## Safety model

Views and materialized views remain read-only in DataTable. Row editing requires an ordinary table, a complete primary key, writable columns, and a writable connection. NexusPilot does not fall back to `ROWID` for updates or deletes.

Schema changes are limited to the common ordinary-table model that can be represented and verified through the shared `SchemaMutator` contract. Unsupported Oracle semantics stay read-only or require explicit SQL.

## Explicitly deferred

- CDB/PDB discovery and lifecycle;
- user, role, privilege, profile, quota, tablespace, and datafile administration;
- wallet, TNS_ADMIN, LDAP, Kerberos, external/proxy authentication, and privileged-role workflows;
- designers for views, materialized views, sequences, triggers, procedures, functions, packages, synonyms, types, and scheduler objects;
- advanced partitioning, LOB storage, physical table options, and specialized index families;
- `ROWID` editing, large LOB editing/streaming, and long-running operation control.

The general “Supported” label does not claim complete Oracle administration parity. Runtime capabilities and the server/permission environment determine which controls appear.

## Implementation references

- [Connection runtime](../../architecture/connection-runtime.md)
- [Database runtime sessions](../../architecture/database-runtime-session.md)
- [Generic schema mutation contract](../../contracts/ipc/schema-mutation.md)
- [Adding a database driver](../../development/add-new-database-driver.md)
