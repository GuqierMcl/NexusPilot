# SQL Editor product design

> Status: **Current**. The described core editing and execution behavior is implemented; explicitly deferred features remain future product direction.

## Product Intent

The near-term SQL editor goal is a basically complete query editing experience for everyday relational database work. The editor should feel reliable when a user writes multiple statements, runs selected SQL or all SQL, optionally runs the current cursor statement, pages through results, runs a simple script, and relies on useful schema-aware completion.

This design intentionally stops before lower-return database IDE features. Query folders/search/history, formatter, Explain, true cancellation, transaction controls, and stable physical SQL sessions are not part of this near-term design.

## Experience Model

The SQL editor has three visible execution commands built on two result flows:

| Mode | Command | Target | Result Shape |
| --- | --- | --- | --- |
| Primary execution | Run | Selected SQL if present, otherwise all executable SQL | One focused result for one statement; ordered script results for multiple statements |
| Current statement execution | Run menu -> Run Current Statement | Statement containing the cursor | One result/status/error with paging |
| Explicit script execution | Run menu -> Run All / Run Selected SQL | Full editor or selected SQL | Ordered per-statement results/statuses/errors |

Primary Run follows the common Navicat-style expectation: a selection narrows the target; no selection means the editor content is the target. Current-statement execution remains available, but it is a narrower sub-action instead of the default button behavior.

Primary execution exposes a compact target hint before execution. The hint uses direct wording such as `将执行已选取 SQL · 1 条`, `将按顺序执行全部 SQL · N 条`, or `输入 SQL 后运行` so users can see the consequence of their current selection before clicking Run. The Run menu item for current-statement execution uses wording such as `运行当前语句` and `将执行当前语句 · 第 N 条`.

## Phase 2 Design: Current Statement And Paging

### Explorer Placement

PostgreSQL query groups belong inside schema nodes. The visual placement is:

```text
connection -> database -> schema -> 查询 -> saved_query
```

Within a schema node, `查询` is a sibling of the virtual asset groups such as tables, views, and materialized views. It is not a sibling of schema nodes under the database.

New PostgreSQL saved queries should have schema context before they are persisted. If an older record only has database context, the implementation should avoid creating `connection -> database -> 查询`; instead, it should normalize the record to a safe schema context when the user opens/saves it or present a clear fallback that does not conflict with the schema-level information architecture.

### Run Target Rules

When the user clicks primary Run:

1. If the editor has non-empty selected SQL text, trim and use the selection.
2. Otherwise, use the full editor text.
3. If the chosen target has no executable SQL, show a validation message and do not call IPC.
4. If the chosen target contains one executable statement, execute it through the focused `execute_sql` flow.
5. If the chosen target contains multiple executable statements, execute them sequentially through the script flow.

When the user chooses `运行当前语句`, the editor ignores selection, finds the executable statement range containing the cursor, and executes only that statement through the focused flow. If no executable statement contains the cursor, it shows a validation message and does not call IPC.

The SQL editor intentionally does not define local keyboard shortcuts in this phase. Shortcut behavior should wait for a centralized application command/shortcut model.

### Statement Range Model

The frontend should introduce a reusable statement range model instead of adding one-off cursor string slicing. The model should expose enough information for Phase 2 and Phase 3:

- statement text;
- start and end offsets;
- start and end line/column when needed by Monaco;
- whether the statement is executable after comments/whitespace are ignored.

The first implementation should handle common SQL statement boundaries:

- semicolon-separated statements;
- trailing semicolon;
- single-quoted strings;
- double-quoted identifiers/strings;
- MySQL backtick identifiers;
- line comments and block comments;
- PostgreSQL dollar-quoted bodies.

Oracle PL/SQL blocks and MySQL `DELIMITER` scripts remain outside the first parser guarantee.

### Result Paging

Focused execution stores a last-execution snapshot:

- SQL text that was actually executed;
- context used for execution;
- current page;
- page size.

Paging actions use the snapshot, not the current editor text. This prevents a common trap: run a query, edit it, then click next page and accidentally execute a different SQL statement.

The result panel should expose paging only when a row result exists. Affected-row statuses and errors do not need paging.

## Phase 3 Design: Script Execution

### Command Separation

Run becomes the primary Navicat-style action: selection first, otherwise all executable SQL. The Run button is a split action whose menu exposes `运行全部`, `运行已选取 SQL`, and `运行当前语句`. This keeps the default fast for common multi-statement editing while still making narrower execution targets explicit.

### Sequential Execution

Script execution runs parsed executable statements in order. It should not run statements concurrently.

The default error policy is stop-on-first-error:

1. Statements before the failure keep their success/result state.
2. The failed statement keeps its structured error.
3. Later statements are marked skipped.

This default is conservative and easy to explain. Continue-on-error can be considered later if users need it.

### Result Model

The result area should evolve from one `QueryResult` to a batch result model for script runs:

- batch id;
- statement list with source text/range;
- per-statement status;
- per-statement result or error;
- execution summary.

The UI should let the user switch between statement outputs. It should always be clear which SQL produced the visible rows or status.

Implemented Phase 3 keeps focused result paging on the existing last-execution snapshot. Script execution displays the first result page for each statement in the batch result detail. Rich per-statement paging can be revisited later if real script usage shows pressure for paging large script outputs.

### Stop Semantics

Phase 3 may offer a script stop command that prevents queued statements from starting. It must not be presented as true cancellation of the currently running SQL. User-facing copy should make that distinction clear.

## Phase 4 Design: Column And Alias Completion

### Completion Targets

Phase 4 implements Level D completion:

- column completion after recognized table prefixes;
- alias completion for simple `FROM table alias` and `JOIN table alias` patterns;
- continued keyword, snippet, database, schema, table, view, and materialized-view completion.

The first Level D slice should favor explicit prefixes over broad inference. For example, `users.` and `u.` are in scope; guessing the right column list for an unqualified `SELECT |` position is not required at first.

Phase 4 deliberately uses lightweight metadata-backed completion rather than a SQL LSP. A full LSP remains a future evaluation path only if diagnostics, formatting, hover, jump-to-definition, or complex semantic inference become product priorities.

### Metadata Strategy

Column metadata should be loaded lazily and cached through existing frontend data-fetching patterns. The implementation should avoid fetching every object's columns in a large schema.

The implemented strategy is:

- use the active SQL editor context to resolve visible databases/schemas;
- infer a small set of table names and aliases from the current statement;
- request column metadata only for those table objects through the existing `describe_table` path;
- keep typing responsive when metadata is unavailable.

Views and materialized views remain in object-name completion, but their column completion is deferred until the backend has a neutral column-metadata contract that is not coupled to table-design metadata.

### Driver Behavior

Identifier insertion follows the existing dialect helpers:

- MySQL uses backticks when quoting is needed.
- PostgreSQL and Oracle use double quotes when quoting is needed.
- Schema/database qualification should not be auto-inserted in the first Level D slice unless the completion item already represents an explicit qualified prefix.

## Non-Goals

The near-term design does not include:

- query folders, query search, or persisted execution history;
- SQL formatter/beautifier;
- Explain/query plan views;
- true database-side query cancellation;
- stable physical SQL sessions;
- transaction toolbar;
- editable free-SQL result grids;
- temporary table or session variable awareness in autocomplete;
- full SQL parser/LSP-grade semantics.

## Acceptance Summary

Phases 2-4 are complete when:

- users can run selected SQL or all SQL from the primary Run button;
- users can run the cursor statement from the Run menu;
- users can page through large focused-query results without changing the executed SQL snapshot;
- users can run a script sequentially and inspect each statement's result or failure;
- queued script statements can be stopped without claiming to cancel the current database operation;
- users get practical column and simple alias completion for MySQL, PostgreSQL, and Oracle contexts;
- the guide and roadmap documents describe the shipped behavior without promising deferred IDE features.
