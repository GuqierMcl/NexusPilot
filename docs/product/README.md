# Product intent and capability boundaries

Documents in this directory explain the intended user experience and the current public scope of significant product areas. They complement, but do not override, capability responses returned by the running application.

| Document | Scope |
| --- | --- |
| [sql-editor.md](./sql-editor.md) | SQL editor execution, result, completion, and deferred-feature model. |
| [database-support/clickhouse.md](./database-support/clickhouse.md) | Current ClickHouse baseline and explicitly deferred deployment/administration scope. |
| [database-support/oracle.md](./database-support/oracle.md) | Current open-box Oracle workbench scope and deferred enterprise capabilities. |
| [database-support/sqlite.md](./database-support/sqlite.md) | Local-file SQLite scope and safety defaults. |

The root README intentionally labels a database as supported without encoding every operation. Product and implementation documents provide the detailed boundary; the runtime capability model remains authoritative for a specific connection, server version, and permission set.
