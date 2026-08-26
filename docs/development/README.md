# Contributor development guides

Status: **Current**

These guides explain how to extend and maintain the implementation. They are not loaded by the public documentation site.

## Core implementation

- [Add a database driver](./add-new-database-driver.md)
- [Backend logging](./backend-logging.md)
- [Database driver icons](./database-driver-icons.md)
- [DataTable](./datatable.md)
- [SQL editor](./sql-editor.md)
- [Code editor](./code-editor.md)
- [Settings page](./settings-page.md)

## Workbench composition

- [Workbench registry constraints](./workbench-registry-constraints.md)
- [Workbench navigation](./workbench-navigation.md)
- [Workbench status bar](./workbench-status-bar.md)
- [Resizable panel behavior](./resizable-panels.md)

## Engine-specific implementation

- [ClickHouse table designer](./clickhouse-table-designer.md)
- [ClickHouse view designer](./clickhouse-view-designer.md)

## Quality and delivery

- [Real database tests](./real-database-tests.md)
- [Release process](./release.md)
- [User-facing copy](./user-facing-copy.md)

When implementation behavior changes, update the relevant architecture or contract document as well as the implementation guide. Never use a personal task plan or AI transcript as the public authority for a design decision.
