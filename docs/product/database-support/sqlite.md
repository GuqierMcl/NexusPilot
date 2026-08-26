# SQLite support

Status: **Current**

NexusPilot treats SQLite as a local-file database, not as a network connection.

## Current baseline

- profiles select a local `.sqlite`, `.sqlite3`, or `.db` file and a read-only/writable mode;
- existing files default to read-only;
- Explorer presents the selected file as the database context and exposes object groups beneath it;
- tables and views can be browsed through DataTable;
- SQL editor execution uses the file context and has no schema selector;
- writable ordinary tables can use DataTable insert, update, and delete when a complete explicit primary key is available;
- DataTable tab runtimes support transactions;
- the structured SQLite Table Designer baseline creates new tables.

## Safety model

The application's own metadata SQLite database and a user-selected SQLite data source use separate pools and paths. A profile does not accept network host, port, account, password, SSH, or TLS fields.

Read-only mode is enforced in the backend. Row editing does not use the implicit `rowid` as a fallback; without a complete explicit primary key, the resource remains read-only. Views are read-only. SQL Editor transaction controls and arbitrary existing-table rebuilds are outside the baseline.

## Explicitly deferred

- networked or remotely mounted SQLite products;
- SSH/TLS/account authentication concepts;
- generic existing-table alteration through a rebuild workflow;
- `rowid`-based editing;
- SQL Editor transaction toolbar and advanced SQLite administration.

## Implementation references

- [Connection runtime](../../architecture/connection-runtime.md)
- [Database runtime sessions](../../architecture/database-runtime-session.md)
- [DataTable implementation](../../development/datatable.md)
- [SQL editor implementation](../../development/sql-editor.md)
