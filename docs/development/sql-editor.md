# SQL Editor Guide

> Status: **Current**. Implemented behavior and maintained near-term product intent are summarized in [SQL editor product design](../product/sql-editor.md).

This guide records the supported SQL query editor workflow for NexusPilot. Phase 4 provides a reliable Navicat-style query loop for SQL-capable connections, and ClickHouse Phase 4A/4B/4C joins that shared tab/runtime with managed direct focused execution, managed sequential Grid scripts, and explicit single-statement Raw results.

## 1. Scope

Implemented Phase 1-4 behavior includes:

- open a SQL editor tab from a connection, database, or schema node;
- choose execution context with driver-aware selectors;
- edit SQL with the project-level `CodeEditor`;
- primary Run executes selected SQL when there is a selection, otherwise all executable SQL in the editor;
- selected SQL and full-editor SQL can contain one statement or several statements; one statement uses the focused result flow, while several statements use the sequential script result flow;
- run the current cursor statement through the Run dropdown action `运行当前语句`;
- show explicit target feedback such as `将执行已选取 SQL · 1 条`, `将按顺序执行全部 SQL · N 条`, or `将执行当前语句 · 第 N 条`;
- render read-only results or affected-row status;
- page through focused row results using the last execution snapshot;
- route focused single-statement execution through a capability-driven managed/legacy lifecycle adapter;
- expose per-tab execution state, timeline, timeout/result mode, a neutral detail drawer, and the shared Workbench bottom status bar;
- reconcile managed Channel notifications with an authoritative snapshot every two seconds when the optional capability is present;
- run ClickHouse focused and script statements with backend execution/query IDs, configurable timeout, best-effort progress/summary, Direct command execution, and a service-confirmed cancel protocol;
- when `managedLifecycle && rawResult`, run one selected or full-editor statement through the explicit Run dropdown action `运行原始结果` without changing the default Grid mode;
- render bounded Raw text/hex preview and metadata, then safely save the owned artifact through the native save dialog;
- expose capability-driven Cancel Active in the SQL Editor toolbar without changing Stop Queue semantics;
- run all parsed executable statements sequentially through the Run dropdown action `运行全部`;
- render script execution as ordered per-statement statuses/results/errors;
- stop queued script statements after the current database operation settles;
- save queries as local metadata under the owning connection;
- render saved queries in Explorer under their execution context, with a connection-level fallback only for context-less queries;
- complete column names after recognized table prefixes and simple aliases.

Implemented scope excludes:

- service-confirmed database-side stop/cancel for drivers other than the ClickHouse Phase 4A implementation;
- SQL formatting or beautification;
- Explain/query plan views;
- editable free-SQL results;
- query folders/search/history;
- restart-time draft recovery;
- SQL editor transaction toolbar or guaranteed session-level transaction workflows.

Implemented Phase 4 adds:

- Level D autocomplete for columns and simple aliases.

Phase 4 still excludes formatter, Explain, stable physical SQL sessions, transaction toolbar, editable free-SQL results, query folders/search/history, diagnostics, and full SQL language-server semantics. ClickHouse now advertises the Phase 4A/4B/4C direct managed + Raw feature set and implements confirmed-cancel/query-wins/`cancelFailed` semantics; its scripts run each Grid statement through managed lifecycle, while MySQL/PostgreSQL/Oracle/SQLite remain on the legacy adapter. The self-hosted HTTP Phase 4A/4B/4C checkpoints and final full-suite acceptance have passed; ClickHouse Phase 4 is complete.

## 2. Driver-Aware Context

The SQL editor context selector follows the driver hierarchy:

| Driver | Selectors |
| --- | --- |
| MySQL | connection + database |
| PostgreSQL | connection + database + schema |
| Oracle | connection + schema; current service/SID/EZConnect alias is internal context |
| SQLite | connection + file database; no schema selector |
| ClickHouse | connection + database; no schema selector |
| Redis | no SQL editor entry |

The selectors affect only the structured execution context. They must not rewrite SQL text, prepend hidden `USE ...`, or inject `SET search_path ...` into the editor content.

The implementation derives database/schema options from the same remote metadata model used by Explorer:

- MySQL: `database -> asset_group -> table/view`;
- PostgreSQL: `database -> schema -> asset_group -> table/view/materialized_view`.
- Oracle current shape: `schema -> asset_group -> table/view/materialized_view`, with the service/SID retained in `ContainerRef.database`. The initial Phase 1 `service/SID -> schema` wrapper is historical only.
- SQLite: `file database -> asset_group -> table/view`; the file database node is the visible SQL context and schema is always empty.
- ClickHouse: `database -> asset_group -> table/view/materialized_view`; it reuses the generic database-only context mode and does not add a driver-specific selector state.

## 3. Saved Queries

Saved queries are local user assets, not remote database objects. They belong to the Storage boundary and use direct Tauri `invoke`, like connection CRUD.

Saved queries are bound to a connection:

- deleting a connection deletes its saved queries;
- Explorer renders saved queries under their execution context;
- a saved query stores its SQL text and default database/schema context.

Explorer placement:

- MySQL: `connection -> database -> 查询 -> saved_query`;
- PostgreSQL: `connection -> database -> schema -> 查询 -> saved_query`;
- PostgreSQL `查询` is a child of the schema node, at the same level as virtual asset groups such as tables, views, and materialized views; it is not rendered as a database child beside schema nodes;
- new PostgreSQL saved queries should carry schema context before saving; legacy database-only PostgreSQL records must not introduce a database-level `查询` group and should be normalized to a schema context when safely resolved;
- SQLite: `connection -> file database -> 查询 -> saved_query`, with `databaseName` set to the file database context and `schemaName=null`;
- MySQL/SQLite database-level and PostgreSQL/Oracle schema-level `查询` groups are shown even when empty because they are also the "new query in this context" entry point;
- context-less saved queries use a connection-level `查询（未指定上下文）` fallback.

Current SQLite shape:

```sql
CREATE TABLE IF NOT EXISTS saved_queries (
    id            TEXT PRIMARY KEY NOT NULL,
    profile_id    TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE ON UPDATE CASCADE,
    title         TEXT NOT NULL,
    driver        TEXT NOT NULL,
    database_name TEXT,
    schema_name   TEXT,
    sql_text      TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    sort_order    INTEGER
);
```

No query folders are part of the implemented SQL editor scope.

## 4. Tab Runtime

SQL editor tabs must use a tab runtime:

1. `open_tab_runtime(profileId, tabId)` when opening a SQL editor.
2. Legacy `execute_sql` or managed `start/get/cancel/release_sql_execution` with the same runtime `tabId` for execution ownership.
3. `close_tab_runtime(tabId)` when closing the tab; the backend first signal-and-discards any owned execution entry, then closes the driver runtime.

The current guarantee is tab-runtime isolation and managed execution/artifact ownership, not a stable physical SQL session. The UI tab ID may differ from `tabRuntimeId`: UI state/navigation uses the former, backend ownership always uses the latter. ClickHouse Phase 4A/4B/4C uses cloned official clients, independent control query IDs, and Manager-owned Raw artifacts without promising a stable socket. Future drivers may add their own control clients, while fixed session connections remain future work for transaction buttons, temporary tables, and session variables.

## 5. Engine Contract

The `execute_sql` call accepts structured context:

```ts
interface SqlExecutionContext {
    database?: string | null;
    schema?: string | null;
}

interface ExecuteSqlArgs {
    profileId: string;
    tabId: string;
    context?: SqlExecutionContext | null;
    sql: string;
    page: number;
    pageSize: number;
}
```

Rules:

- SQL editor calls pass `tabId`; no silent shared-runtime fallback.
- MySQL accepts database context and hides schema selection.
- PostgreSQL accepts database and schema context.
- Oracle accepts schema context and loads schema options directly from the connection root; the service/SID wrapper is not part of the visible SQL Editor selector model.
- SQLite accepts the file database context, hides schema selection, and rejects non-empty `schema`.
- ClickHouse accepts database context, hides schema selection, and rejects non-empty `schema`; context selection changes the request client database without modifying editor SQL.
- The primary Run action supports multiple executable statements by using the script execution flow.
- `运行当前语句` sends exactly one cursor statement through the capability-driven managed/legacy lifecycle adapter.
- Empty SQL is handled in the frontend before IPC.

SQLite SQL Editor uses the file database node as its database context and has no schema selector. The backend accepts one statement per `execute_sql` IPC call; the frontend script runner sends multi-statement scripts as sequential single-statement calls. SELECT/WITH statements return paged read-only result grids, and explicit DDL/DML statements return affected-row results when the SQLite profile is opened writable.

### 5.1 ClickHouse Phase 4A/4B/4C managed direct and Raw policy

ClickHouse free SQL preserves the exact user statement. The driver does not wrap it in a subquery, append LIMIT, or prepend `USE`. Read statements use `ReadOnlyGrid`, apply `readonly=2` plus fixed JSON quoting/UTF-8 settings, and decode the NexusPilot-owned Grid format. Classified DDL、INSERT、DELETE、Mutation、SYSTEM and command statements use `DirectGrid` with official `Query::execute()` and `wait_end_of_query=1`; this command path does not append a result FORMAT. Unknown statements remain server-authoritative through `DirectGrid`. The legacy DataTable/SQL adapter remains read-only. Managed focused and script statements accept the neutral per-tab configurable operation timeout and map it to both the client deadline and ClickHouse `max_execution_time`.

The local Grid protocol guard accepts one non-empty statement and rejects top-level `FORMAT` and `INTO OUTFILE`, because NexusPilot owns `JSONCompactEachRowWithNamesAndTypes`. Explicit Raw accepts those directives and uses `DirectRaw + fetch_bytes("TabSeparatedRaw")`; the default-format query parameter does not rewrite the SQL body, so an explicit user `FORMAT` remains authoritative. CSV/TSV/JSON/XML receive bounded text previews, while Parquet/Arrow/Native/ORC/Avro receive `[hex]` previews. A zero-byte `INTO OUTFILE` is a server-side command outcome, not a local artifact. Grid pagination does not rewrite SQL: the decoder skips rows before the requested page, retains `pageSize+1`, and releases the cursor early. Requests that would skip more than 100,000 rows are rejected with guidance to add a filter or LIMIT. This differs from ClickHouse DataTable browsing, which uses server-side LIMIT/OFFSET.

### 5.2 Focused execution lifecycle

`DriverCapabilities.sqlExecutor` remains the gate for opening and using SQL Editor. The optional `DriverCapabilities.sqlExecution` describes the richer lifecycle:

```ts
interface SqlExecutionFeatures {
    managedLifecycle: boolean;
    statementAccess: "readOnly" | "direct";
    activeCancel: boolean;
    liveProgress: boolean;
    querySummary: boolean;
    rawResult: boolean;
    configurableTimeout: boolean;
}
```

Focused execution selects its path only from `features?.managedLifecycle`; it never checks a driver name. Capability absent/false uses legacy `execute_sql` and wraps the `QueryResult` in a frontend-only `legacy-*` snapshot. Managed mode uses `start_sql_execution`, immediately calls `get_sql_execution_snapshot`, and continues a two-second authoritative reconciliation while active. Tauri Channel events may reduce latency, but a lost event is not a query failure. Snapshots are accepted only for the same execution ID with a higher revision, and terminal state never returns to active.

ClickHouse Phase 4A/4B/4C advertises the exact feature set `managedLifecycle=true`、`statementAccess=direct`、`activeCancel=true`、`liveProgress=true`、`querySummary=true`、`rawResult=true`、`configurableTimeout=true`. The Manager rejects Raw before registration when that neutral feature is false; when true it creates and transfers one unique artifact writer. The driver classifies the statement before registration, assigns a backend query ID, selects `ReadOnlyGrid`、Direct command or `DirectRaw` as described above, polls `system.processes` best-effort at 750ms with at most one request in flight, and merges live metrics with an available official response summary. Missing progress permission/columns/transport becomes bounded `observationWarnings` and does not fail the main query.

The result surface consumes neutral `SqlExecutionOutcome` variants. Rows render a grid; commands render their completion message and statement class; Raw renders format/media/JSON-safe byte length, bounded preview, truncation/hex markers and an “另存为” action without entering DataGrid or paging. Missing metrics stay missing: command execution never invents `affectedRows=0`, and a row count appears only when the backend actually provides affected rows or JSON-safe final written rows. Partial live-poll counters remain observable while running but are not promoted into a terminal command summary. Mutation commands explicitly say the request was submitted and may continue asynchronously; command success is not evidence that the server-side mutation has completed.

Raw is a per-run override, not a persistent tab preference. Primary Run、Run All、Run Selection、Run Current Statement、pagination and every script statement remain Grid. `运行原始结果` appears only for `managedLifecycle && rawResult`, accepts a single selected statement or a single full-editor statement, and rejects multi-statement targets with `原始结果每次只允许执行一条 SQL`. `lastExecution.resultMode` records the actual run for details, while the tab default remains Grid for the next normal Run.

The backend stores Raw bytes under an opaque artifact ID with a 512 MiB maximum, a 1 MiB text preview buffer, and a 4 KiB binary preview buffer. The result view derives a default filename only from a format allowlist and uses the Tauri save dialog; canceling the picker performs no backend call. Saving validates profile/runtime-tab/execution/artifact ownership and keeps the source for retry. A new execution, explicit release, tab close, profile disconnect, app teardown, cancel, timeout, transport error, or size-limit failure cleans the matching source/partial artifact.

Cancel Active first returns `canceling`; only an exact confirmed `KILL QUERY WHERE query_id = ? SYNC` result can produce `canceled`. A query that completes first wins as `succeeded`; an unconfirmed control result becomes `cancelFailed`. A configured operation timeout remains `timedOut` with `businessOnly` impact and performs only a best-effort server stop; failure to confirm that stop is an observation warning, not a replacement terminal state. A local cancellation token by itself never proves server cancellation.

Each UI tab stores `activeExecution`, `lastOutcome`, a state-change-only timeline, timeout/result-mode options, and `executionDetailOpen` in B-domain runtime state. Starting a new focused execution releases the previous terminal managed entry first; an active previous execution is rejected. The fixed timeout menu contains 30 seconds, 1 minute, 5 minutes, 15 minutes, 1 hour, and no execution timeout. It is per-tab runtime state, is not persisted to a profile or saved query, is absent without `configurableTimeout`, and cannot change during focused or script execution.

`Run All` and multi-statement selection execute statements sequentially through the same capability-driven lifecycle; legacy drivers are adapted inside that lifecycle rather than called directly from the View. Every statement records execution/query identity, snapshot, outcome, error, timing, and one of `succeeded/failed/timedOut/canceled/cancelFailed/skipped`. Any non-success terminal state stops the remaining queue. Stop Queue does not cancel the active statement; Cancel Active also stops future statements but waits for the server-confirmed snapshot instead of locally inventing `canceled`. The backend Manager still coordinates one active statement per tab and does not own a script queue or script transaction.

The neutral execution detail drawer shows execution/query identity, state/timing, progress availability, timeout/result mode, all available summary fields, failure code/runtime impact/message, cancellation message, and neutral Raw artifact metadata (format、media type、byte length、preview-truncated state、opaque artifact ID). It intentionally excludes SQL text, preview/raw bytes, temp/destination paths, developer-only error details, and Cancel/Run/Retry/Save actions. Driver-specific focused details must use the detail contributor registry. The ClickHouse built-in contributor displays progress availability, summary source/completeness, JSON-safe memory usage, and observation warnings; it does not add execution actions.

## 6. Editor Usage

Business code must use the shared editor package:

```tsx
<CodeEditor
    value={sqlText}
    language="sql"
    preset="sqlEditor"
    height="100%"
    heightMode="fixed"
    onChange={setSqlText}
/>
```

Do not import `@monaco-editor/react` outside `src/components/editor/`.

Because Workbench content uses React `Activity`, hidden SQL editor tabs must not keep Monaco mounted. When `isActive` is false, render a same-size placeholder or otherwise unmount `CodeEditor`; keep SQL text in tab runtime state instead of relying on Monaco instance state.

## 6.1 Autocomplete

The SQL editor uses Monaco autocomplete through the project-level `CodeEditor` mount lifecycle.

Implemented completion scope:

- SQL keywords and common snippets;
- database names for SQL-capable relational drivers;
- schema names for PostgreSQL and Oracle;
- table, view, and materialized-view names for the active database/schema context;
- column names after recognized table prefixes such as `users.`, `"users".`, or `` `users`. ``;
- column names after simple aliases from `FROM users u`, `FROM users AS u`, and `JOIN orders o`.

Autocomplete reuses the existing `list_containers` metadata model and TanStack Query cache. It does not add a backend autocomplete IPC, does not fetch metadata on every keystroke, and does not use the SQL execution tab runtime.

Column completion is intentionally lightweight. It uses the active SQL editor context, the existing object metadata cache, and the existing table schema metadata path. It does not start a SQL LSP, does not add diagnostics, does not format SQL, and does not infer CTEs, nested subqueries, temporary tables, or session variables.

In the first implemented Level D slice, column metadata is fetched only for table objects because the current backend metadata contract is `describe_table`. View and materialized-view objects still participate in object-name completion, but they do not yet expose column completion until a future neutral column metadata contract exists.

## 7. Toolbar

`SqlEditorView` publishes its own toolbar actions through `ContentToolbarAction[]`:

- primary split Run button;
- Run menu actions: run all, run selected SQL, run current statement, plus capability-driven `运行原始结果` for one explicit Raw statement;
- cancel the active focused statement when `managedLifecycle && activeCancel` and state is `starting/running`;
- stop queued script statements while a script batch is active;
- save;
- new query;
- toggle result panel.

Do not show format or Explain actions in the implemented Phase 1-4 toolbar. Cancel Active belongs to the SQL Editor toolbar: it stays visible but disabled while the snapshot is `canceling`, and disappears for terminal states. The script Stop Queue action is only shown while a script batch is active, and it only prevents queued statements from starting after the current SQL settles; it does not cancel the active SQL.

The SQL editor does not define local keyboard shortcuts. Shortcut behavior is deferred until the whole application has a centralized command/shortcut design, so feature code does not accumulate scattered bindings.

## 8. Result Rendering

The result panel is collapsed by default. Running SQL expands the resizable result panel and shows loading, read-only rows/status, or inline errors.

Focused execution renders one focused result/status/error. Row results expose previous/next paging when `QueryResult.hasNextPage` indicates more data or the current page is greater than 1. Paging uses the SQL text, context, and page size from the last execution snapshot, not the current editor contents, so editing SQL after page 1 does not accidentally change page 2.

Script execution renders an ordered batch result model. Each parsed statement has a stable index, SQL preview, status, elapsed time when available, and a detail panel showing row results, affected-row status, skipped state, or structured error. The default script policy is stop-on-first-error: statements after the failed statement are marked skipped. The Stop Queue action only stops queued statements after the current SQL completes; it does not cancel the active database operation.

Raw execution renders `RawSqlResultView`, not `RelationalDataTable`. It displays only bounded preview and neutral artifact metadata; `[hex]` is labeled as binary/invalid-UTF-8 preview, and `previewTruncated` is explicit. Raw has no previous/next page controls. Saving is an explicit result-view action; the status bar and execution detail drawer remain observation/navigation surfaces.

The Workbench bottom status bar is the only persistent execution summary. It shows the active tab state on the left, JSON-safe summary metrics on the right, and background active/failure counts. Clicking a single target focuses its tab and opens the neutral detail drawer; multiple targets open the lightweight overview. SQL Editor does not add a second persistent status strip.

Free-SQL results are read-only. Even if `QueryResult` carries writable resource metadata, SQL editor result grids must not enable:

- cell editing;
- insert row;
- delete row;
- DML preview;
- table transaction controls.

Those workflows remain exclusive to table data tabs.

## 9. Dirty State

Dirty state compares the current SQL text and execution context against the saved snapshot:

- unsaved query with non-empty SQL is dirty;
- saved query is dirty when SQL text, database, schema, or title differs from the saved record;
- dirty SQL tabs participate in close confirmation for both individual tabs and the application window.

The implemented SQL editor does not persist unsaved drafts across app restart.

## 10. Near-Term Completion Roadmap

Current agreed near-term slices:

1. Phase 4: Level D semantic completion with columns and simple aliases. Implemented.
2. Phase 4A frontend observability: capability-driven focused lifecycle, Channel/snapshot reconciliation, shared status bar, detail registry, and multi-target overview. Implemented and accepted against self-hosted HTTP.
3. ClickHouse Phase 4B: Direct DDL/DML command execution, neutral command outcome, managed sequential scripts, Stop Queue/Cancel Active separation, and per-tab timeout menu. Implemented and accepted against self-hosted HTTP `26.5.1.882`.
4. ClickHouse Phase 4C: explicit single-statement Raw, bounded text/hex preview, Manager-owned artifact, retryable save, size/cancel/release/tab/profile/app cleanup. Implemented and accepted against self-hosted HTTP `26.5.1.882`; Phase 4 final full-suite acceptance is complete.

Deferred beyond the near-term SQL editor target:

- SQL formatter;
- Explain/query plan views;
- stable SQL session connection and transaction toolbar;
- saved query folders/search/history;
- editable free-SQL result grids;
- full SQL parser/LSP-grade semantics.
