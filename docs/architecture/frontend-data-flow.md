# 前端数据通信规范

> 本文档描述 NexusPilot 连接引擎模块的前后端通信协议。本地 SQLite CRUD 仍使用直接 `invoke` 封装，例如 `src/lib/tauri/connections.ts` 与 `src/lib/tauri/saved-queries.ts`；用户数据源运行时统一通过 `src/lib/api-client.ts` 的 `apiInvoke()` 调用。

---

## 1. Engine IPC 命令

所有连接引擎命令均返回结构化 `IpcResult<T>`，失败时序列化为 `IAppError`。

| 命令 | 参数 | 返回类型 | 说明 |
|------|------|----------|------|
| `connect_profile` | `{ profileId }` | `ConnectionRuntimeInfo` | 从 SQLite 读取 profile，创建 shared runtime，并返回后端真实 capabilities |
| `disconnect_profile` | `{ profileId }` | `void` | 关闭 shared runtime，并级联关闭该 profile 的 tab runtime |
| `test_connection` | `{ profileId }` | `PingResult` | 对已连接 runtime 做 ping |
| `test_connection_config` | `{ driver, payload }` | `ConnectionTestResult` | 使用未保存的表单配置临时建连、测试并释放资源；不写入 SQLite，不创建 shared runtime |
| `get_connection_capabilities` | `{ profileId }` | `ConnectionRuntimeInfo` | 查询后端真实能力 |
| `open_tab_runtime` | `{ profileId, tabId }` | `ConnectionRuntimeInfo` | 为 Tab 创建独立 runtime/session |
| `close_tab_runtime` | `{ tabId }` | `void` | 释放 Tab runtime/session |
| `list_containers` | `{ profileId, parent? }` | `DataContainer[]` | 统一结构树浏览 |
| `describe_clickhouse_table_schema` | `{ profileId, container }` | `ClickHouseTableSchema` | ClickHouse native schema 强类型 Describe；editability 与 capability 共同决定是否可写 |
| `preview_create_clickhouse_database` / `create_clickhouse_database` | `{ profileId, target|request }` | `NativeSchemaMutationPreview` / `ClickHouseCreateDatabaseResult` | ClickHouse native database create |
| `preview_create_clickhouse_table` / `create_clickhouse_table` | `{ profileId, target|request }` | `NativeSchemaMutationPreview` / `ClickHouseCreateTableResult` | ClickHouse native table create 与真实 Describe result |
| `preview_alter_clickhouse_table` / `alter_clickhouse_table` | `{ profileId, target|request }` | `NativeSchemaChangePlan` / `ClickHouseTableAlterResult` | ClickHouse table ALTER；完整 baseline、desired target、显式 rename、plan hash、确认与 drift gate |
| `preview_clickhouse_column_action` / `execute_clickhouse_column_action` | `{ profileId, target|request }` | `NativeSchemaChangePlan` / `ClickHouseColumnActionResult` | ClickHouse 整列 CLEAR/MATERIALIZE；服务端接受后返回 submitted |
| `preview_drop_clickhouse_table` / `drop_clickhouse_table` | `{ profileId, target|request }` | `NativeSchemaChangePlan` / `ClickHouseDropTableResult` | ClickHouse native table drop；需要后端确认并证明 absence |
| `preview_drop_clickhouse_database` / `drop_clickhouse_database` | `{ profileId, target|request }` | `NativeSchemaChangePlan` / `ClickHouseDropDatabaseResult` | ClickHouse native database drop；baseline 包含 child object snapshot |
| `preview_clickhouse_projection_change` / `execute_clickhouse_projection_change` | `{ profileId, target|request }` | `NativeSchemaChangePlan` / `ClickHouseProjectionChangeResult` | ClickHouse Projection Create/Drop/Materialize/Clear；完整 table baseline 与精确 operation gate |
| `preview_clickhouse_skipping_index_change` / `execute_clickhouse_skipping_index_change` | `{ profileId, target|request }` | `NativeSchemaChangePlan` / `ClickHouseSkippingIndexChangeResult` | ClickHouse Index Create/Drop/Materialize/Clear；五类 allowlist 与精确 operation gate |
| `get_clickhouse_view_runtime_support` | `{ profileId, database?, ownerTabRuntimeId? }` | `ClickHouseViewRuntimeSupport` | 七类 View family 的 operation 三态、support revision 与 Cluster publication 状态 |
| `describe_clickhouse_view_schema` | `{ profileId, request }` | `ClickHouseViewSchema` | persistent View/MV 或 owner-scoped Temporary View Describe |
| `preview_create_clickhouse_view` / `create_clickhouse_view` | `{ profileId, target|request }` | `NativeSchemaMutationPreview` / `ClickHouseViewCreateResult` | Local/Temporary View/MV create；Cluster 在基础版发送前拒绝 |
| `preview_change_clickhouse_view` / `execute_clickhouse_view_change` | `{ profileId, target|request }` | `NativeSchemaChangePlan` / `ClickHouseViewChangeResult` | View/MV Alter/Rename/Drop；完整 baseline、support revision、确认、drift 与 post-proof |
| `list_clickhouse_temporary_views` | `{ profileId, ownerTabRuntimeId }` | `ClickHouseViewSchema[]` | 读取指定 SQL owner runtime 的 Session Views；不进入 shared Explorer |
| `preview_create_table` | `{ profileId, input }` | `SchemaMutationPreview` | 表设计器新建表 DDL 预览；当前支持 MySQL / PostgreSQL / Oracle 已落地建表子集 |
| `create_table` | `{ profileId, input }` | `CreateTableResult` | 表设计器新建表落库；预览与执行使用同一后端 DDL 生成逻辑 |
| `preview_update_table` | `{ profileId, input }` | `SchemaMutationPreview` | 表设计器已有表 ALTER TABLE 预览；支持 MySQL / PostgreSQL / Oracle 常用改表子集与 destructive warning |
| `update_table` | `{ profileId, input }` | `UpdateTableResult` | 表设计器已有表结构保存；执行前重新读取 schema 做 drift detection |
| `preview_drop_table` | `{ profileId, input }` | `SchemaMutationPreview` | Explorer 普通表删除预览；后端生成 DROP TABLE SQL 并标记 `destructive=true` |
| `drop_table` | `{ profileId, input }` | `DropTableResult` | Explorer 普通表删除执行；要求 `confirmDestructive=true`，当前支持 MySQL / PostgreSQL / Oracle |
| `browse_table_data` | `{ profileId, tabId?, container, page, pageSize, query? }` | `QueryResult` | 表/视图数据浏览 intent；DataTable tab 必须传 `tabId` 走独享 runtime；不执行 `COUNT(*)` |
| `get_table_page_stats` | `{ profileId, tabId?, container, pageSize, query?, requestedPage? }` | `TablePageStats` | 懒加载表/视图总行数与总页数；仅在跳转页码或最后一页时调用 |
| `update_table_row` | `{ profileId, tabId?, container, primaryKey, changes }` | `TableMutationResult` | 仅支持真实表 + 完整主键的单行更新 |
| `delete_table_rows` | `{ profileId, tabId?, container, primaryKeys }` | `TableMutationResult` | 仅支持真实表 + 完整主键的一行或多行删除 |
| `preview_table_change_set` | `{ profileId, tabId?, container, changeSet }` | `TableChangeSetPreview` | 预览 DataTable change set 即将执行的 DML SQL；v1 支持 insert/update/delete |
| `commit_table_change_set` | `{ profileId, tabId?, container, changeSet }` | `TableChangeSetCommitResult` | 提交 DataTable change set；若当前 tab 已开启事务，则写入该事务连接 |
| `begin_tab_transaction` | `{ profileId, tabId, container }` | `TableTransactionState` | 在指定 DataTable tab runtime 上开启事务并绑定数据库 |
| `commit_tab_transaction` | `{ profileId, tabId }` | `TableTransactionState` | 提交指定 tab runtime 的活动事务 |
| `rollback_tab_transaction` | `{ profileId, tabId }` | `TableTransactionState` | 回滚指定 tab runtime 的活动事务 |
| `get_tab_transaction_state` | `{ profileId, tabId }` | `TableTransactionState` | 查询指定 tab runtime 是否处于事务中 |
| `execute_sql` | `{ profileId, tabId, context?, sql, page, pageSize }` | `QueryResult` | 仅执行用户显式输入的 SQL；SQL 编辑器要求传 `tabId` 与结构化 context，并限制单次执行一个语句 |
| `start_sql_execution` | `{ profileId, tabId, request, onEvent }` | `SqlExecutionHandle` | 为声明 managed lifecycle 的 tab runtime 启动单语句 execution；`onEvent` 是 Tauri Channel bridge |
| `get_sql_execution_snapshot` | `{ profileId, tabId, executionId }` | `SqlExecutionSnapshot` | 读取权威 execution snapshot，用于 start 后立即对账和 2 秒 reconciliation |
| `cancel_sql_execution` | `{ profileId, tabId, executionId }` | `SqlExecutionSnapshot` | 请求取消并立即返回 `canceling`；terminal 结果由 Channel/snapshot reconciliation 到达，未获服务端确认不得伪造 `canceled` |
| `release_sql_execution` | `{ profileId, tabId, executionId }` | `void` | 释放 terminal execution ownership；active execution 不可释放 |
| `browse_key_tree` | `{ profileId, request }` | `RedisKeyTreeResult` | Redis key 前缀树摘要，完整扫描匹配范围并返回精确递归计数；key 节点包含 Redis 类型用于列表 badge |
| `scan_key_values` | `{ profileId, request }` | `RedisScanResult` | Redis SCAN |
| `get_key_value` | `{ profileId, keyRef }` | `RedisKeyValue` | Redis value 稳定结构化读取，返回 TTL、`MEMORY USAGE` 大小与 opaque value fingerprint；RedisJSON 通过 `JSON.GET` 读取 |
| `set_key_value` | `{ profileId, request }` | `RedisKeyMutationResult` | Redis value 原子整体替换；支持 string/json/hash/list/set/zset/stream，要求 `expectedFingerprint`，默认保留 TTL |
| `create_key_value` | `{ profileId, request }` | `RedisKeyMutationResult` | Redis 新建 key；支持 string/json/hash/list/set/zset/stream，目标 key 已存在时拒绝覆盖 |
| `delete_key` | `{ profileId, request }` | `RedisDeleteKeyResult` | Redis 删除单个 key；要求 `expectedFingerprint`，不存在或 stale 返回无业务效果错误 |
| `delete_key_prefix` | `{ profileId, request }` | `RedisDeleteKeyResult` | Redis 删除前缀目录下所有后代 key；后端完整 `SCAN pattern` 后批量 `DEL`，拒绝空 pattern 与全局 `*` |
| `rename_key` | `{ profileId, request }` | `RedisKeyMutationResult` | Redis key 重命名；要求 source `expectedFingerprint`，目标 key 已存在或并发出现时拒绝覆盖 |

`update_table_row/delete_table_rows` 是关系型主键兼容入口；ClickHouse 不把 sorting/primary key 冒充唯一键，因此只通过 `preview_table_change_set/commit_table_change_set` 接收中性 `rowSnapshot` locator。旧式主键命令在 ClickHouse 上返回可操作的 `FEATURE_UNAVAILABLE`，引导用户回到 DataTable 保存流程或 SQL 编辑器。
| `set_key_ttl` | `{ profileId, request }` | `RedisKeyMutationResult` | Redis TTL 独立原子修改；要求 `expectedFingerprint`，`expire` 要求正整数秒数，`persist` 移除过期时间 |

旧命令已移除，不保留 wrapper 兼容层。

SQL 查询编辑器的 legacy 与 managed lifecycle 行为见 [sql-editor.md](../development/sql-editor.md)。保存查询 CRUD 属于本地 Storage IPC，而不是 Engine IPC：`list_saved_queries`、`get_saved_query`、`create_saved_query`、`update_saved_query`、`delete_saved_query` 像连接 CRUD 一样走直接 `invoke` 封装。保存查询删除策略为随连接级联删除。

---

## 2. 共享数据类型

类型定义位于 `src/types/ipc.ts`，与 Rust 的 `src-tauri/src/engine/types.rs` 对齐。

```ts
type SchemaMutationOperation =
    | "create"
    | "alter"
    | "rename"
    | "drop"
    | "clear"
    | "materialize";

interface SchemaMutationObjectFeatures {
    kind: ContainerKind;
    operations: SchemaMutationOperation[];
}

interface SchemaMutationFeatures {
    objects: SchemaMutationObjectFeatures[];
    ddlPreview: boolean;
    destructiveConfirmation: boolean;
    remoteDriftProtection: boolean;
}

interface DriverCapabilities {
    schemaBrowser: boolean;
    schemaMutator: boolean;
    schemaMutation?: SchemaMutationFeatures;
    dataTableBrowser: boolean;
    tableRowMutator: boolean;
    tableRowInserter: boolean;
    transactionManager: boolean;
    sqlExecutor: boolean;
    sqlExecution?: SqlExecutionFeatures;
    keyValueBrowser: boolean;
    graphQueryer: boolean;
    vectorSearcher: boolean;
}

interface ConnectionRuntimeInfo {
    profileId: string;
    driverName: string;
    capabilities: DriverCapabilities;
}

type ContainerKind =
    | "asset_group"
    | "database" | "schema"
    | "table" | "view" | "materialized_view"
    | "function" | "procedure" | "trigger" | "index"
    | "dictionary" | "projection"
    | "sequence" | "extension" | "event" | "column"
    | "collection" | "document" | "field"
    | "node_label" | "relationship_type"
    | "vector_collection" | "partition"
    | "search_index" | "data_stream" | "mapping_field"
    | "redis_database" | "redis_key_prefix" | "redis_key";

type AssetGroupType =
    | "tables" | "views" | "materialized_views"
    | "functions" | "procedures" | "indexes"
    | "dictionaries" | "projections" | "triggers"
    | "sequences" | "extensions" | "events"
    | "collections" | "documents" | "fields"
    | "node_labels" | "relationship_types"
    | "vector_collections" | "partitions"
    | "search_indexes" | "data_streams"
    | "templates" | "mappings" | "constraints" | "columns";

interface ContainerRef {
    kind: ContainerKind;
    groupType?: AssetGroupType | null;
    database?: string | null;
    schema?: string | null;
    table?: string | null;
    column?: string | null;
    objectName?: string | null;
    dbIndex?: number | null;
    key?: string | null;
    pattern?: string | null;
}

interface SqlExecutionFeatures {
    managedLifecycle: boolean;
    statementAccess: "readOnly" | "direct";
    activeCancel: boolean;
    liveProgress: boolean;
    querySummary: boolean;
    rawResult: boolean;
    configurableTimeout: boolean;
}

interface ContainerProperty {
    key: string;
    label: string;
    value: string;
}

interface DataContainer {
    id: string;
    name: string;
    kind: ContainerKind;
    isLeaf: boolean;
    container: ContainerRef;
    typeName?: string | null;
    nullable?: boolean | null;
    itemCount?: number | null;
    properties?: ContainerProperty[];
}

interface SchemaMutationPreview {
    statements: string[];
    warnings?: string[];
    destructive?: boolean;
}

interface TableColumnRename {
    oldName: string;
    newName: string;
}

interface UpdateTableInput {
    container: ContainerRef;
    baseline: TableSchema;
    target: TableSchema;
    columnRenames?: TableColumnRename[];
    confirmDestructive?: boolean;
}

interface UpdateTableResult {
    container: ContainerRef;
    tableName: string;
}

interface DropTableInput {
    container: ContainerRef;
    confirmDestructive?: boolean;
}

interface DropTableResult {
    container: ContainerRef;
    tableName: string;
}

type ColumnDataCategory =
    | "string" | "number" | "boolean" | "date" | "time" | "datetime"
    | "json" | "structured" | "enum" | "binary" | "uuid" | "unknown";

interface ColumnMeta {
    name: string;
    typeName: string;
    nullable: boolean;
    defaultValue?: string | null;
    dataCategory: ColumnDataCategory;
    maxLength?: number | null;
    numericPrecision?: number | null;
    numericScale?: number | null;
    enumValues?: string[] | null;
    isPrimaryKey: boolean;
    primaryKeyOrdinal?: number | null;
    isUnique: boolean;
    isWritable: boolean;
}

interface TableBrowseFilter {
    column: string;
    operator: string;
    value?: unknown;
}

interface TableBrowseSort {
    column: string;
    direction: string;
}

interface TableBrowseQuery {
    filters: TableBrowseFilter[];
    sort: TableBrowseSort[];
}

type JsonSafeInteger = number | string;

interface TablePageStats {
    totalRows: JsonSafeInteger;
    totalPages: JsonSafeInteger;
    pageSize: number;
}

interface SqlExecutionContext {
    database?: string | null;
    schema?: string | null;
}

interface CreateTableInput {
    basics: TableSchemaBasics;
    columns: TableColumnSchema[];
    indexes: TableIndexSchema[];
    constraints: TableConstraintSchema[];
}

interface CreateTableResult {
    container: ContainerRef;
    tableName: string;
}
```

关系型对象分组统一使用 `kind: "asset_group"` 与 `groupType`，例如 `tables`、`views`、`functions`、`indexes`。Redis 专属类型：`RedisScanRequest`、`RedisKeyTreeRequest`、`RedisKeyTreeResult`、`RedisKeyRef`、`RedisKeyInfo`、`RedisScanResult`、`RedisKeyValue`、`RedisKeyPrecondition`、`RedisEditableValue`、`RedisSetKeyValueRequest`、`RedisCreateKeyValueRequest`、`RedisDeleteKeyRequest`、`RedisDeleteKeyPrefixRequest`、`RedisDeleteKeyResult`、`RedisRenameKeyRequest`、`RedisSetKeyTtlRequest`、`RedisKeyMutationResult`。Redis value 读取支持 `string/json/hash/list/set/sorted_set/stream/unsupported`；写入和新建使用 `RedisEditableValue`，不接受 binary string，hash/list/set/sorted_set/stream 整体替换时必须至少包含一个成员。RedisJSON module 类型会规范化为 `json`，读取使用 `JSON.GET key`，写入使用 `JSON.SET key $ <json>`。读取和 mutation response 携带基于 DUMP bytes 的 opaque fingerprint；Workbench value draft 保存 baseline fingerprint，set/rename/TTL/delete 必须回传该前置条件，成功结果更新 baseline。TTL 修改独立于 value dirty 状态，`set_key_ttl` 不重建 value；新建 key 的 TTL 作为 create draft 一部分提交给 `create_key_value`。删除单 key 使用 `delete_key`；目录删除仍使用 `delete_key_prefix`，返回 `deletedCount` 供前端提示与刷新，但它不属于 Agent Tool。

表数据浏览结果携带资源能力元数据：`QueryResult.sourceWritable`、`QueryResult.sourceInsertable`、`rowLocatorStrategy`、`primaryKeyColumns`、`stableOrderColumns` 与 `columns[].isWritable/isPrimaryKey`。`rowLocatorStrategy` 为 `primaryKey | rowSnapshot | null`；关系型驱动继续返回主键策略，ClickHouse 返回原始行快照策略且 `primaryKeyColumns` 保持为空。`sourceWritable` 表达 update/delete 的资源可写性，`sourceInsertable` 单独表达 insert 能力。`ColumnMeta.dataCategory` 由后端统一归类；`structured` 是 Array/Map/Tuple/Nested/Variant 等中性只读类别，共享 DataTable 不读取 driver name。

`TablePageStats.totalRows/totalPages` 使用 JSON-safe integer：安全范围内保持 number，超过 `Number.MAX_SAFE_INTEGER` 时序列化为十进制 string。前端比较、格式化与页码换算必须通过 BigInt-backed helper；当最后页超过 IPC 的 `u32` page 边界时，仍显示精确总数，但禁用直接跳到最后一页。

前端 DataTable 操作需同时满足驱动能力和资源能力：更新单元格要求 `tableRowMutator=true`、`sourceWritable=true`、存在 `rowLocatorStrategy` 且目标列可写；删除要求同样具备 locator，并在标记前输入表名确认；新增要求 `tableRowInserter=true`、`sourceInsertable=true` 且容器为真实表。`TableRowLocator` 是 tagged union：`primaryKey { parts }` 与 `rowSnapshot { parts, expectedMatches }` 不可混用。ClickHouse snapshot 由当前页原始、非 binary/structured/unknown 列值构造，后端重新校验并执行匹配数证明。只有 `applied` 才清空 change set；`outcomeUnknown` 与 `conflict` 保留草稿并分别提示先核对事实或刷新重编。Insert 未填写列不会进入请求，由数据库 default / identity / auto increment 处理。

`TableBrowseQuery` 是表格浏览和分页统计共用的结构化查询条件入口，确保数据页与 `COUNT(*)` 使用同一份过滤条件。它支持最多 10 个以 `AND` 组合的固定枚举过滤条件（`eq/not_eq/gt/gte/lt/lte/is_null/is_not_null`）和最多 5 个 `asc/desc` 排序字段；列名必须匹配 Driver 读取到的真实列并按方言引用，过滤值只通过参数绑定进入查询。它不接受 SQL、表达式、函数、JOIN 或聚合。普通 `browse_table_data` 不统计总页数；`get_table_page_stats` 按同一 `TableBrowseQuery` 执行计数。空表按 `totalPages = 1` 返回。

---

## 3. apiInvoke 规范

`apiInvoke<T>(command, args?, options?)` 是连接引擎 IPC 的唯一前端入口。

| 场景 | 行为 |
|------|------|
| 成功 | 透明返回 `T` |
| 失败且带 `IAppError` | 根据 `code` 显示 toast，DEV 模式打印 details，随后重新抛出；带 `profileId` 且 `runtimeImpact` 为 retryable/terminal 时发布通用 runtime failure event |
| Tauri 框架错误 | 包装为 `SYSTEM_INTERNAL` 后同上 |
| `silent: true` | 跳过 toast，交给调用方自行处理 |
| `trackRuntimeHealth: false` | 本次调用不发布 runtime failure event，用于 disconnect 和 recovery probe，避免反馈回路 |

Engine IPC 错误码包含 `AUTH_FAILED`、`NETWORK_TIMEOUT`、`OPERATION_TIMEOUT`、`QUERY_SYNTAX_ERROR`、`RESOURCE_NOT_FOUND`、`VALIDATION_FAILED`、`RESOURCE_CONFLICT`、`SYSTEM_INTERNAL`、`OPERATION_CANCELED`。每个 `IAppError` 还包含显式 `runtimeImpact: "businessOnly" | "retryable" | "terminal"`；前端不从错误码推断 session health。旧后端或非结构化 rejection 缺少该字段时兼容为 `businessOnly`。Redis 写入校验失败使用 `VALIDATION_FAILED`，新建/重命名目标 key 已存在使用 `RESOURCE_CONFLICT`。

```ts
const containers = await apiInvoke<DataContainer[]>(
    "list_containers",
    { profileId, parent: null },
    { silent: true },
);
```

---

## 4. Query Key

Query key 工厂位于 `src/lib/query-keys.ts`。所有远端数据 key 均以 `["metadata", profileId]` 为前缀。显式断开先让 session 进入 `disconnecting`，再对该前缀执行 `cancelQueries` 与 `removeQueries`；不能用 invalidate 代替 teardown 清理，否则 active observer 可能在断开过程中重新取数。

| 方法 | 用途 |
|------|------|
| `queryKeys.profile(profileId)` | 某 profile 的所有远端缓存 |
| `queryKeys.containers(profileId, parent?)` | 某父容器下的子容器 |
| `queryKeys.tableData(profileId, tabRuntimeId, container, params)` | 某个 DataTable tab runtime 下的表/视图分页数据，`params` 包含 page/pageSize/query |
| `queryKeys.tableDesign(profileId, tabRuntimeId, context?)` | 表设计器读取现有表结构的只读 schema 缓存 |
| `queryKeys.clickHouseTableDesign(profileId, tabRuntimeId, container?)` | ClickHouse native 表结构缓存；ownership 精确到 profile/tab/container |
| `queryKeys.clickHouseViewSupport(profileId, ownerTabRuntimeId, database, clusterRevision)` | ClickHouse View family/runtime support snapshot；support/topology revision 变化使旧 preview 失效 |
| `queryKeys.clickHouseViewDesign(profileId, ownerTabRuntimeId, scope, family, container, clusterRevision)` | persistent、Cluster contract 或 Temporary View/MV definition；Temporary ownership 精确到 owner runtime |
| `queryKeys.clickHouseTemporaryViews(profileId, ownerTabRuntimeId)` | 指定 owner HTTP session 的 Temporary View 列表 |
| `queryKeys.clickHouseViewGroup(profileId, database, kind)` | Views/Materialized Views Explorer group 的精确失效边界 |
| `queryKeys.clickHouseViewDependencies(profileId, container)` | View/MV 变更影响的依赖缓存边界 |
| `queryKeys.sqlExecution(profileId, tabRuntimeId, executionSnapshot)` | SQL 编辑器：某次 SQL 执行快照对应的只读结果 key；当前执行结果保存在 tab runtime state |
| `queryKeys.savedQueries(profileId)` | SQL 编辑器：某连接下的本地 saved query 列表，保持 profile 级失效边界 |
| `queryKeys.keyTree(profileId, request)` | Redis key 前缀树摘要 |
| `queryKeys.keyValues(profileId, request)` | Redis key 扫描结果 |
| `queryKeys.keyValue(profileId, keyRef)` | Redis 单 key 详情 |

---

## 5. Query Hooks

Query hooks 位于 `src/hooks/queries/use-db-metadata.ts`。

| Hook | IPC | enabled 条件 |
|------|-----|--------------|
| `useContainers(profileId, parent?)` | `list_containers` | `session.status === "connected"` |
| `useTableData(profileId, tabRuntimeId, container, params)` | `browse_table_data` | 已连接且 `container.kind` 为 `table` / `view` / `materialized_view` |
| `useTableSchema(profileId, tabRuntimeId, container?, enabled?)` | `describe_table` | 已连接、显式 enabled、且 `container.kind === "table"` |
| `useClickHouseTableSchema(profileId, tabRuntimeId, container?, enabled?)` | `describe_clickhouse_table_schema` | 已连接、显式 enabled、table 地址同时含 database/table；使用 30 秒 staleTime 与通用 retry policy |
| `usePreviewCreateClickHouseDatabase` / `useCreateClickHouseDatabase` | ClickHouse native database create commands | mutation；driver operation adapter 使用 fresh preview |
| `usePreviewCreateClickHouseTable` / `useCreateClickHouseTable` | ClickHouse native table create commands | mutation；create surface 使用 target/hash gate |
| `usePreviewAlterClickHouseTable` / `useAlterClickHouseTable` | ClickHouse native table alter commands | mutation；edit surface 使用 debounce preview 与 fresh baseline/hash/confirm execute |
| `usePreviewClickHouseColumnAction` / `useExecuteClickHouseColumnAction` | ClickHouse native column action commands | mutation；只接受 clear/materialize target |
| `usePreviewDropClickHouseTable` / `useDropClickHouseTable` | ClickHouse native table drop commands | mutation；通用 drop adapter 负责 fresh preview 与确认 |
| `usePreviewDropClickHouseDatabase` / `useDropClickHouseDatabase` | ClickHouse native database drop commands | mutation；通用 drop adapter 负责 object snapshot drift 与确认 |
| `usePreviewClickHouseProjectionChange` / `useExecuteClickHouseProjectionChange` | ClickHouse native projection change commands | mutation；专属 section 使用单对象 pending action、fresh plan 与完整 table baseline |
| `usePreviewClickHouseSkippingIndexChange` / `useExecuteClickHouseSkippingIndexChange` | ClickHouse native skipping-index change commands | mutation；专属 section 使用五类 allowlist、fresh plan 与完整 table baseline |
| `useClickHouseViewRuntimeSupport` | `get_clickhouse_view_runtime_support` | 已连接；按 database/owner runtime 读取七类 family 三态与 support revision |
| `useClickHouseViewSchema` | `describe_clickhouse_view_schema` | persistent 需要 database，Temporary 需要 owner runtime 且 database 为空 |
| `useClickHouseTemporaryViews` | `list_clickhouse_temporary_views` | owner SQL runtime 存在；只读取该 session 的 Temporary View |
| `usePreviewCreateClickHouseView` / `useCreateClickHouseView` | View create commands | mutation；完整 target、support revision、fresh plan/hash 与 scope gate |
| `usePreviewChangeClickHouseView` / `useExecuteClickHouseViewChange` | View change commands | mutation；Alter/Rename/Drop 共用 typed baseline、确认、drift 与结果语义 |
| `usePreviewCreateTable(profileId)` | `preview_create_table` | mutation；表设计器 create 模式防抖调用，默认 silent |
| `useCreateTable(profileId)` | `create_table` | mutation；表设计器 create 模式保存调用 |
| `usePreviewUpdateTable(profileId)` | `preview_update_table` | mutation；表设计器 edit 模式防抖调用，默认 silent |
| `useUpdateTable(profileId)` | `update_table` | mutation；表设计器 edit 模式保存调用 |
| `usePreviewDropTable(profileId)` | `preview_drop_table` | mutation；Explorer 删除表 SQL 预览，默认 silent |
| `useDropTable(profileId)` | `drop_table` | mutation；Explorer 删除普通表，调用方必须传 `confirmDestructive=true` |
| `useSqlExecutionLifecycle` | `start/get/cancel/release_sql_execution` 或 `execute_sql` | 单语句只按可选 `sqlExecution.managedLifecycle` 选择 managed/legacy；Channel 通知与权威快照对账写入 per-tab runtime state |
| `SqlEditorView` 脚本 runner | `execute_sql` | `Run All` 与多语句 selection 仍按顺序执行 legacy 单语句调用，保持 stop-on-first-error 与 Stop Queue |
| `WorkbenchExplorerPanel` saved-query queries | `list_saved_queries` | SQL 编辑器本地 Storage IPC，按 profile 加载保存查询并按 execution context 注入 Explorer `查询` 节点 |
| `useKeyTree(profileId, request)` | `browse_key_tree` | 已连接 |
| `useKeyValues(profileId, request)` | `scan_key_values` | 已连接 |
| `useKeyValue(profileId, keyRef)` | `get_key_value` | 已连接且 key 非空 |
| `useSetKeyValue(profileId)` | `set_key_value` | mutation，默认非 silent |
| `useCreateKeyValue(profileId)` | `create_key_value` | mutation，默认非 silent |
| `useDeleteKey(profileId)` | `delete_key` | mutation，默认非 silent |
| `useDeleteKeyPrefix(profileId)` | `delete_key_prefix` | mutation，默认非 silent |
| `useRenameKey(profileId)` | `rename_key` | mutation，默认非 silent |
| `useSetKeyTtl(profileId)` | `set_key_ttl` | mutation，默认非 silent |

查询 Hook 使用同一 retry 策略：仅显式 `runtimeImpact="retryable"` 的错误最多重试 3 次；错误码本身不决定是否重试。Redis 写入与删除 mutation 使用 `apiInvoke` 默认错误处理；失败会弹 toast 并重新抛出，调用方后续成功逻辑不会执行。

---

## 6. Tab Runtime State

Tab 内容状态采用三层边界：

| 层级 | 来源 | 说明 |
|------|------|------|
| Tab 身份 | `WorkbenchTab.payload` | 打开标签页所需的稳定信息，例如 `profileId`、`tabRuntimeId`、`container`、Redis `dbIndex/pattern/selectedKey` |
| 远端数据 | TanStack Query | 表格 rows/columns、Redis key tree、Redis value 等服务端数据缓存；SQL 编辑器执行结果保存在 tab runtime state，saved query 列表通过 `queryKeys.savedQueries(profileId)` 管理失效边界 |
| Tab 内状态 | `tab-runtime-state-slice` | 当前页码、懒加载分页统计快照、页码输入态、选择、编辑态、change set、事务告警、SQL 文本草稿、SQL 保存快照、SQL 执行上下文、`activeExecution/lastOutcome/executionTimeline/executionOptions/executionDetailOpen`、legacy-compatible result/error、SQL 结果面板折叠与尺寸状态、通用 `schemaDesignByTabId` 加载/editability/operation 摘要、独立 `clickHouseTableDesignByTabId` 与 `clickHouseViewDesignByTabId` draft/snapshot/support/preview/conflict/outcome/background state、Redis 当前 key、Redis 目录折叠状态、Redis 预览栏折叠状态、Redis string 预览格式手动覆盖、Redis 可编辑 value 草稿与待丢弃确认 |

`sql_editor` 与 `table_data` 打开时会创建 tab runtime。DataTable 的浏览、DML 预览和 change set 提交默认传 `tabId`，因此走 tab 独享连接；Explorer 元数据、连接 ping 和 Redis key-value 浏览继续走 shared runtime。后端收到非空 `tabId` 时必须命中对应 tab runtime，不会静默回退到 shared runtime。Oracle 与 SQLite 事务期间，DataTable browse、page stats 与 change set commit 会复用同一条 pinned connection；SQLite 的 metadata-only PRAGMA 查询可使用 tab pool 的第二条连接。SQLite 直接复用 `begin_tab_transaction`、`commit_tab_transaction`、`rollback_tab_transaction` 与 `get_tab_transaction_state`，没有新增 SQLite 专属 IPC。SQL editor 仍保持独立的显式 SQL 结果路径，不参与 DataTable 事务 UI。

SQL editor 的 `WorkbenchTab.payload` 只保存 `profileId`、`tabRuntimeId`、可选 `savedQueryId`、初始 context 和打开时返回的 runtime capability；SQL 文本、保存快照、context dirty 状态、execution snapshot/outcome/timeline/options、结果/error、detail open、结果面板 collapsed/size 状态放入 `tab-runtime-state-slice`。这些 execution 字段属于连接运行时 B 域，不能写入本地 profile A 域，也不做重启持久化。切换 tab 或 React `Activity hidden` 时不得依赖 Monaco 实例保存草稿或 DOM 布局；隐藏时卸载编辑器或渲染同尺寸占位。

`tab-runtime-state-slice` 以 `tabId` 为 key 保存 `sql_editor`、`table_data`、`table_design`、native schema design 与 `key_value` 的运行时状态。`schemaDesignByTabId` 使用 `mode`、`loading/ready/restricted/readonly/error`、`previewing/previewReady/applying/submitted/partiallyApplied/outcomeUnknown/conflict`、dirty、blocker count 与 error message 的通用模型，不读取 driver name；ClickHouse create/edit 的结构化 draft/snapshot、conflict remote schema、pending column action 与单个 `pendingObjectAction` 独立保存在 `clickHouseTableDesignByTabId`，不塞入关系型 `TableDesignRuntimeState`。主表 ALTER preview 与对象 preview 互斥；主表 dirty、对象 applying 或 submitted/partial/unknown/conflict 待核对时不能启动新的对象动作。切换 tab、React `Activity hidden` 或组件重挂载不会清理这些状态；只有真正关闭 tab、成功 retarget/保存后以真实 schema 替换 snapshot、撤回修改或用户确认丢弃刷新时才会清理对应状态。React `Activity hidden` 会清理 view effects，因此 native schema view 的 effect cleanup 只撤销 fetching/toolbar 发布；真正关闭 tab 才由 `removeTabRuntimeState()` 删除 schema design state。

Key/Value editable draft 的 `baselineFingerprint` 与当前 base key/value 同步更新；rename 成功返回的新 fingerprint 是随后 set 的前置条件，set 成功后再次替换 baseline。删除未打开的单 Key 时，Frontend 会先读取详情取得 fingerprint，再进入现有确认流程。

`table_design` 的草稿状态与 `table_data` change set 完全隔离：`useTableSchema` 负责读取远端 schema 缓存；首次成功时必须建立远端 baseline，后续用户已编辑时，后台 refetch 不覆盖本地草稿。create / edit 的数据库与 Schema 来自 explorer 入口的 `container` / `parentContainer`，在 UI 中作为固定上下文展示，不允许用户在草稿里改写目标库或目标 Schema。

ClickHouse 使用独立 `clickhouse_table_design` tab。`schema-designer-surface-registry` 根据 driver/object/mode/capabilities 选择关系型或 native surface：table/edit 可由 `schemaBrowser=true` 打开无损只读 surface；Columns/Engine/TTL 写控件要求 table/alter，column action 要求 column/clear|materialize，Projection/Index section 分别要求对应 object/operation。table/create 要求 table/create。content renderer/lifecycle registry 让每个 profile/context 只有一个 create tab，edit tab 按 `profileId + database + table` 去重；create applied 后复用同一个 tab id retarget 为 edit，不关闭再新建。公共 Explorer/Content shell 不包含 ClickHouse driver 分支。

`ClickHouseTableDesignView` 的 edit mode 通过 `useClickHouseTableSchema()` 读取远端强类型 schema，固定展示 Columns、Engine & Keys、TTL & Settings、Projections、Data-skipping Indexes 五个 section。Columns、Engine & Keys、TTL & Settings 使用专属 edit draft；engine、ORDER/PARTITION/PRIMARY key 仍只读，只有 SAMPLE BY 可改。Phase 5D 的 Projections 与 Data-skipping Indexes section 提供强类型 Create/Drop/Materialize/Clear；已有对象不做 inline rename/modify，未知 query/family/缺字段对象只展示 blocker。对象依赖继续让前三个 section 与 column action fail closed，但不会禁用对象 section。create mode 只展示前三个可编辑 section，使用独立强类型 draft 映射 Database/Table target。刷新、保存、DDL 预览、确认与重置草稿由 view 发布到公共 Content Toolbar/contained drawer；公共底部状态栏从中性 operation state 展示预览、提交、部分应用、结果未知和冲突。

Create preview 使用 500ms debounce、request id 与 target key 双重 stale gate；只有当前 target 对应的单 statement、非 destructive、非 long-running、64 位 lowercase plan hash preview 才能启用保存。execute 携带当前 target 与该 hash。applied 时先把返回的真实 Describe schema写入 cache，再以同一 tab id retarget edit 并用真实 schema 建立 baseline；`OPERATION_OUTCOME_UNKNOWN` 时保持 create mode、dirty draft 与 `container=null`，不 retarget、不清空，并禁止复用旧 preview。`schema-design-status-contributor` 在公共底部状态栏展示 previewing/previewReady/applying/outcomeUnknown；它只读取 active tab 的通用 runtime snapshot，不判断 driver name。

Edit preview 同样使用 500ms debounce、request id 与 target key stale gate。请求包含完整 baseline、desired target 与显式 rename intents；响应包含 exact statements、operation summaries、完整 preview baseline、expected target revision、destructive/long-running 和 plan hash。execute 只使用当前 fresh plan，并携带 `confirmDestructive`。`applied` 时以返回的真实 Describe schema替换 draft/snapshot/cache；`submitted` 用于 CLEAR/MATERIALIZE，只表示服务端接受；`partiallyApplied/outcomeUnknown` 不使用 desired target 覆盖 baseline。若 post-Describe 可读，冲突态保存真实 remote schema；不可读时保留原 snapshot 与 dirty draft。`RESOURCE_CONFLICT` 进入 conflict 并要求刷新后重新 preview。

Projection/Index object lifecycle 复用同一 fresh target/baseline/hash/confirm 原则，但每次只维护一个 pending object action。Create/Drop 的 `applied` 会精确失效 table Describe、对应 `projections`/`indexes` asset group 与 table children；`submitted/partiallyApplied/outcomeUnknown/conflict` 只刷新权威 Describe，不在前端合成或乐观改写对象列表。Materialize/Clear 的 submitted 保留对象 action identity，供底部状态栏提示用户刷新核对。

`clickhouse_view_design` 由 content tab/lifecycle/surface registry 注册，七类 family editor 共享 identity/family/scope/support header、validation、DDL drawer、确认、background work 与中性 Toolbar/Status 状态。persistent create tab 每次显式创建，edit tab 按 `profileId + kind + database + objectName` 去重；Create/Alter/Rename/Drop 同一时刻只允许一个 pending action。preview 绑定 draft key、support revision 和 baseline revision，旧 support、旧定义或旧 scope 不能执行。`applied` 使用后端 post-Describe 的真实 schema 更新 snapshot；`submitted/partiallyApplied/outcomeUnknown/conflict` 不乐观合成 Explorer 对象或 desired definition。

Temporary View 不进入 shared Explorer。SQL Editor 的 ClickHouse Session Views contributor 打开依附当前 `tabRuntimeId` 的 temporary designer；若从其他入口创建 Temporary View，会先建立 owner SQL Editor。dependent designer 不调用 `open_tab_runtime/close_tab_runtime`，所有 support/Describe/query/DDL 都携带逻辑 `ownerTabRuntimeId` 路由到 owner tab driver。关闭 owner 时 lifecycle registry 级联关闭 dependents；关闭 dependent 不关闭 owner。前端和 IPC 只看逻辑 owner，永远不接收物理 ClickHouse `session_id`；session 过期后不自动重建。

`TableSchemaDraft` 与 IPC `TableSchema` 已支持 Phase 5 advanced 字段：列级 `identity` / `generated` / `charset` / `collation`，约束级 `foreignKey` / `enforced`，以及表级 `partition`。表设计器当前是固定上下文栏 + Columns / Indexes / Constraints / Options / Partitions tabs 的专业结构设计工作台。Columns tab 使用 grid + 右侧属性面板维护常用二维字段和高级字段；Indexes / Constraints tabs 使用独立属性面板编辑列顺序、外键引用和 CHECK 表达式；Options / Partitions tabs 按 driver profile 隐藏不适用字段。前端新增 driver-aware structured column type draft，用长度、精度、小数位、时间精度、unsigned 和 Oracle BYTE/CHAR 语义生成 `typeName`；无法识别或自定义类型进入 Raw 类型模式。DDL 预览使用 contained drawer 展示 validation warnings、backend warnings、destructive warnings 和 SQL，并支持复制当前 SQL 与导出 `.sql` 文件；edit 模式 toolbar 提供“刷新结构”，dirty 时必须确认丢弃草稿后才会用远端 `describe_table` 结果重置 `draft`/`snapshot`。

create 模式下，`TableDesignView` 将 `TableSchemaDraft` 映射为 `CreateTableInput`，通过 `preview_create_table` 防抖生成真实 DDL；保存按钮只有在草稿 dirty、固定上下文有效且当前输入的 preview 成功后启用。`create_table` 保存成功后，同一个 tab 会 retarget 为 `mode: "edit"` 并绑定新表 `container`，随后立即调用 `describe_table` 读取数据库真实 schema，用该结果重置 `draft`/`snapshot`，再刷新 profile metadata。

edit 模式下，`TableDesignView` 将 snapshot 映射为 `UpdateTableInput.baseline`，将当前草稿映射为 `UpdateTableInput.target`，并通过 `columnRenames` 显式传递已有列的重命名关系；随后通过 `preview_update_table` 防抖生成 ALTER TABLE 预览。尚未拿到远端 baseline 或固定上下文无效时，不会启用 ALTER 预览或保存。当 `preview_update_table` 返回 `destructive: true` 时，前端必须展示破坏性确认；只有用户确认后，`update_table` 才会携带 `confirmDestructive: true`。未确认的 destructive update 必须由后端拒绝。保存时调用 `update_table`，后端先重新 `describe_table` 并与 baseline 比较，若远端结构已漂移则返回 `RESOURCE_CONFLICT`；保存成功后前端再次 `describe_table`，用真实 schema 更新 snapshot、清除 dirty，并刷新 table design schema cache 与 profile metadata。

当前 edit 模式支持受控子集：表注释、MySQL 表级 engine / charset / collation、可安全添加的列、删除已有列、已有列重命名、类型变更、默认值与可空性变更、列注释、列级 charset/collation、索引新增 / 删除 / 修改（按 drop + create 执行）、基础 primary key 变更、FK / CHECK 增删改（修改按 drop + add 执行），以及 PostgreSQL identity add/drop/set generation。类型变更、删除列、主键变更、约束删除、generated/identity 高风险重写等可能属于 destructive preview；删除列不会自动级联删除依赖索引/约束，目标草稿仍引用被删列时会被拒绝。MySQL generated columns 和列级 charset/collation 已改为结构化 contract 回放；带 `ON UPDATE` 但无显式 default 的字段，以及 `information_schema.COLUMNS.COLUMN_DEFAULT` 无法安全回放的默认值元数据仍会保守拒绝（fail closed）。已有表分区变更不自动执行，后端返回 `VALIDATION_FAILED`，需要通过手写 DDL 管理分区迁移。

Explorer 的结构入口先用 `schemaMutation` 对 object/operation 做具体授权，再由 database operation adapter、schema drop operation registry 或 schema designer surface registry 选择执行/UI。ClickHouse 在 connection/database context 暴露 name-only 新建数据库，在 database/tables group 暴露 native 新建表，在 Views/Materialized Views group 暴露对应 create，在 persistent View/MV 叶子暴露设计、重命名和删除；table 与 View/MV 分别进入专属 surface。通用删除 dialog 与 driver contributor 选择关系型或 native preview/execute，不在公共 shell 判断 ClickHouse；最终提交必须使用当前 fresh preview 的 target/baseline/hash 并传所需 typed confirmation。成功后按同一 `profileId + ContainerRef` 关闭或失效相关 data/design tab，精确刷新 definition、asset group 与依赖缓存；submitted/partial/unknown/conflict 不乐观改写对象列表。

DataTable 的总行数/总页数是按需快照，只有用户跳转页码或点击最后一页时通过 `get_table_page_stats` 拉取；保存成功、撤回、刷新、提交/回滚事务、pageSize/query/container 变化后会失效。Redis KeyValueView 的 key tree 摘要与 value 数据仍由 TanStack Query 管理，runtime store 保存当前 key、折叠目录、预览栏状态、当前 key 的 string 预览格式手动覆盖、可编辑 value 的 key/value 草稿、新建 key 草稿，以及 dirty 时切换 key、刷新或删除前的待确认动作；没有手动覆盖时，前端会对 UTF-8 string 自动识别文本、JSON 或 XML，binary string 不参与文本格式识别。Redis value 详情按 Redis 类型分发到轻量预览组件，UTF-8 string 使用统一 `CodeEditor` 进入可编辑预览，文本/JSON/XML 只切换语言高亮与初始格式化；RedisJSON 使用 JSON `CodeEditor`，不显示文本/JSON/XML 切换；hash/list/set/zset/stream 使用 `RedisEditableDataTable` 并通过 `set_key_value` 整体替换保存；binary string 与 unsupported 类型保持只读。Redis key 浏览区右键菜单由 `KeyValueView` 发布：空白处支持新建与刷新，key/prefix 节点额外支持删除，prefix 删除会先确认并调用 `delete_key_prefix` 删除该前缀下所有后代 key。

### 6.1 SQL execution lifecycle

SQL Editor 的前端 lifecycle adapter 同时持有两个不能混用的 ID：UI `tabId` 用于 Zustand、Workbench 导航、详情开关和状态栏目标；`runtimeTabId` 用于 `start/get/cancel/release_sql_execution` 以及 legacy `execute_sql` ownership。公共代码不得假设两者相等。

只有 `features?.managedLifecycle === true` 才进入 managed 路径；capability 缺失或 false 时继续由同一 lifecycle adapter 调用 legacy `execute_sql`。legacy 结果会包装为只存在前端 B 域、以 `legacy-` 开头的 synthetic `SqlExecutionSnapshot`，让结果面板、公共底部状态栏和详情抽屉共享同一状态模型。MySQL/PostgreSQL/Oracle/SQLite 仍由 legacy adapter 承载；ClickHouse Phase 4A/4B/4C focused 与 script statement 声明精确 feature：`managedLifecycle=true`、`statementAccess=direct`、`activeCancel=true`、`liveProgress=true`、`querySummary=true`、`rawResult=true`、`configurableTimeout=true`。

AI Runtime 的 ClickHouse 原始 SQL 入口不会伪造前端 tab。它在 Rust shared profile runtime 内复用同一 `ManagedSqlExecutor` 和 driver-owned classifier，固定 Grid、30 秒 backend timeout 与唯一 query id，并把异步 mutation acknowledgement 投影为 `submitted` 而不是已完成。Frontend 仍只通过 Workbench Domain Event/Snapshot 看共享连接状态，不接收或维护这次 Agent execution 的第二份生命周期。

Managed 路径中，Tauri `Channel` 只是低延迟通知通道，`get_sql_execution_snapshot` 才是权威恢复路径。start handle 返回后必须立即 get 一次快照；只要 execution 仍 active，就每 2 秒 reconciliation。Channel 丢失或 get 单次失败只记录诊断，不生成虚假 query failure；同 execution 只接受更高 revision，terminal snapshot 不回退。generation identity 防止卸载组件、切换 runtime 或新一轮执行后，旧 Channel callback 污染当前 tab。

Coordinator 的 state transition、有效 summary/progress 更新和有效 `observationWarnings` 新增都会递增 revision。warning 重复或已达到最多 4 条时是 no-op，不递增 revision，也不发 Channel；每条 warning 最多 256 个 Unicode scalar values，且只表达 progress/control 的非终止降级。ClickHouse progress 以 best-effort summary 更新进入同一 snapshot；字段缺失不补 0，超出 JavaScript 安全整数范围的指标继续以十进制 string 表达。

`cancel_sql_execution` 的同步返回只表示已受理并进入 `canceling`，不是服务端终态。ClickHouse 后台 control 只有 exact target 的 `KILL QUERY ... SYNC` 返回 `finished` 才发布 `canceled`；查询先完成时可从 `canceling` 进入 `succeeded`，未确认控制面进入 `cancelFailed`。前端仍按 revision 处理这些竞态，不根据本地 Abort/cancellation token 推断服务端状态。

默认 Run、当前语句、selection、分页和顺序脚本都显式使用 `resultMode=grid`。只有 `managedLifecycle && rawResult` 时，Run dropdown 才发布“运行原始结果”；它把 selection 或全文解析为一条 statement，多语句会在前端提示后停止，绝不进入 script runner。Raw 是单次 execution override：`lastExecution.resultMode` 记录本次实际值用于结果与详情，tab 的 `executionOptions.resultMode` 仍保持 Grid，因而下一次普通 Run 不会被隐式切换成 Raw。

Raw outcome 只进入 `RawSqlResultView`，不进入 `RelationalDataTable` 或分页。前端只持有 format、media type、JSON-safe byte length、bounded preview、preview-truncated 标记和 opaque artifact ID；不持有后端 temp path。另存流程先通过 Tauri save dialog 选择 destination，用户取消时不调用后端；确认后以 `profileId + runtimeTabId + executionId + artifactId + destinationPath` 调用 `save_sql_execution_artifact`。默认文件名只由受控 format allowlist 推导，失败日志不记录 destination、preview 或 SQL，source artifact 保留以便重试。

同一 SQL tab 同时只允许一个 active execution。新一轮开始前，active old snapshot 返回 `RESOURCE_CONFLICT`；terminal managed snapshot 先调用 release，legacy synthetic snapshot 只清理本地状态。focused 与 script statement 都调用同一 capability-driven lifecycle；脚本不再从 View 直接调用 legacy IPC。每条 statement 在 tab B 域保存自己的 execution ID、query ID、snapshot、outcome、error、开始/结束时间和 elapsed，并使用 `succeeded/failed/timedOut/canceled/cancelFailed/skipped` 完整终态；任一非 `succeeded` 终态都会停止后续语句。

Stop Queue 只设置“停止后续队列”，不会取消 active statement；active 结束后其真实终态仍被保留，未开始的 statement 标记为 `skipped`。Cancel Active 同时请求停止队列和当前 managed execution，但前端不会根据本地请求伪造 `canceled`，仍等待服务端确认后的 snapshot；失败或未确认取消分别保留真实 `failed/cancelFailed` 边界。后端 Manager 只管理当前 statement，不建立脚本队列。

可配置 timeout 的固定选项为 30 秒、1 分钟、5 分钟、15 分钟、1 小时和无执行超时。选择值属于当前 SQL tab 的 B 域 runtime state，不写入 profile、saved query 或其他 A 域持久化；执行或脚本运行中禁止修改。无 `configurableTimeout` capability 时 toolbar action 缺席，公共 `ContentToolbar` 只渲染中性的 secondary action menu，不识别 SQL、timeout 或 driver。

---

## 7. 连接会话状态

`connection-session-slice` 保存前端数据库运行时会话状态和后端真实 capabilities。正式语义见 [database-runtime-session.md](./database-runtime-session.md)：profile 存在只代表 A 域配置存在，只有后端完成真实探测并注册 shared runtime 后才是 `connected`；连接状态不承诺某条 socket 常驻，也不直接保存 metadata 树。

```text
idle/error -> connecting -> connect_profile -> connected/error
connected -> degraded -> reconnecting -> connected/error
connecting/connected/degraded/reconnecting/error -> disconnecting -> idle
```

`schemaMutation` 是具体结构操作的权威 capability；前端使用 `supportsSchemaMutation(capabilities, kind, operation)` 判断 create/alter/rename/drop/clear/materialize。ClickHouse 基础版有 Database、Table、Column、Projection、Index、View、Materialized View 七个精确对象项；View/MV 静态操作均为 create/alter/rename/drop，但具体 family/scope 还必须命中运行时 support 三态。`schemaMutator` 只作为关系型 `SchemaMutator` 的迁移期兼容字段存在，不能推导某个具体操作，也不要求 native extension 为了开放结构化 create 而把该字段设为 true。只读 schema surface 可以由 `schemaBrowser` 和 surface registration 开放，不需要伪装成 mutation capability。

首次连接只调用一次 `connect_profile`；driver 在返回前已经完成真实 probe，前端不再重复 ping。每轮初始 connect 由 `connection-runtime-connect-attempts.ts` 分配 attempt identity，disconnect 会取消 identity，新一轮 connect 会覆盖旧 identity；只有 current attempt 的 success/error 才能写入 session。`apiInvoke` 只把带 `profileId` 且显式为 `retryable/terminal` 的失败发布到 session store：terminal 直接进入 `error`；retryable 先进入 `degraded`，再由每 profile 唯一 recovery coordinator 以 `0/500/1500ms` 延迟执行最多 3 次 `test_connection`。重复故障复用已有恢复 Promise；前端 coordinator identity/abort 保护状态边界，Rust attempt 与 driver shutdown signal 负责真正释放构造或探针资源。

`disconnect(profileId)` 先进入 `disconnecting` 并取消初始 connect attempt 与 recovery，再调用 `disconnect_profile`；随后无论后端关闭是否成功都会结束本地 session。断开 profile 的 UI 入口还会关闭关联 tabs，先 cancel/remove 该 profile 的 TanStack Query cache，再清理 Explorer metadata。`connecting/connected/degraded/reconnecting/error` 均提供关闭入口，`disconnecting` 不允许重复操作。公共 store、状态视觉、metadata 准入和恢复策略没有 ClickHouse 专属分支。

Frontend 与 AI Runtime 使用不同 intent 入口，但 Rust 侧汇入同一个 Workbench Application Service 和同一个 `ConnectionRuntimeManager`。L6.5-B 已增加 `connection-runtime-changed` Tauri Workbench Domain Event 和 `list_connection_runtime_snapshots` 只读 IPC：Event 触发 `connectionSessionStore`、Query cache 和 Explorer 投影更新，Snapshot 用于启动、窗口重新聚焦、监听重建或漏事件后的恢复。初始化对账期间会缓存并随后重放实时事件，避免旧 Snapshot 覆盖新状态。Frontend session 不成为第二份连接事实，AI Runtime EventBus/SSE 也不承载该 Workbench 状态同步。

Runtime materialization 与 Explorer metadata hydration 是两个独立事实。Snapshot 恢复出的 `connected + capabilities` 只证明 Rust shared runtime 可用，不表示当前 WebView 的 `loadedChildren` 已存在。因此连接节点在已 connected 但尚未加载 metadata 时，双击和箭头都必须调用 `loadChildren`；该调用跳过 `connect_profile`，只执行 `list_containers`。`loadedChildren[profileId] = []` 仍表示加载已经完成，避免空结果被反复请求。

Explorer 只在 `connected + schemaBrowser=true` 时加载远程 metadata。`connected + schemaBrowser=false` 视为已连接但不支持 schema browsing，不显示连接失败；ClickHouse 当前返回 `schemaBrowser=true`、`dataTableBrowser=true`、`tableRowMutator=true`、`tableRowInserter=true`、`sqlExecutor=true`，按 Phase 4A/4B/4C 开启 direct managed/cancel/progress/summary/raw-result/configurable-timeout，并按 Phase 5A–5E 精确声明七个对象项及 DDL Preview/destructive confirmation/remote drift protection。`statementAccess=direct`、`rawResult=true`、native schema mutation 与 DataTable row/transaction capability 相互独立；`schemaMutator/transactionManager` 仍为 false，`clusterDdl.executable` 也固定为 false。ClickHouse DataTable 只有普通 Local `MergeTree/ReplacingMergeTree` Table 的已支持标量列返回 `sourceWritable/sourceInsertable` 和 `rowSnapshot` locator，其他资源保持只读。`outcomeUnknown` 只表示某次写入的远端结果待确认，不得直接推断 profile 已断开或把 dirty draft 当作确定未执行；validation/conflict/feature-unavailable/permission-denied 保持 `businessOnly`。`degraded/reconnecting` 保留已加载 children，不以空数组覆盖，也不重复创建 runtime。单个 parent 的 `businessOnly` metadata/query 失败不改变 profile runtime health；profile cache key 按完整 `${profileId}::` 边界清理，不能让 `profile-1` 误匹配 `profile-10`。

---

## 8. Content Toolbar 动作状态

`ContentToolbar` 渲染 active tab 发布的 `ContentToolbarModel`。该模型包含 `actions`、可选 `context` 和可选 `emptyText`；公共 Toolbar 不再维护 `TabType` 到操作、图标或上下文的映射。DataTable 的工具栏模型由 `TableDataView` 根据三层状态发布：

| 层级 | 来源 | 用途 |
|------|------|------|
| 驱动能力 | `connection-session-slice.capabilities` | 判断驱动是否会浏览、修改、事务等能力 |
| 资源能力 | `QueryResult` | 判断当前表/视图是否可写、是否有主键、列是否可写 |
| UI 状态 | 当前 Tab state | 判断是否有选中行、是否正在 fetching/mutating |

当前 DataTable 工具栏固定发布事务、刷新、新增行、删除选中行、保存更改、撤回更改。未开启事务时显示“开始事务”；开启后同一位置替换为“提交”和“回滚”。开始事务要求驱动暴露 `transactionManager`、当前资源存在 database context，并且 `sourceWritable || sourceInsertable`；这会阻止 SQLite read-only profile、view、无主键表和二进制主键表开始事务，同时保留 MySQL/PostgreSQL 可插入无主键表的既有资格。开始事务和提交事务都要求本地 change set 为空；事务中点击“保存更改”会把 change set 写入当前 tab 的事务连接，最终结果由后续提交或回滚决定。SQLite 使用 `BEGIN IMMEDIATE`，事务保持期间可能占用写锁，工具栏与状态栏沿用通用锁提示。事务中表格外框显示事务态边框；如果事务内保存 change set 失败，`tab-runtime-state-slice` 会将该 tab 标记为 `rollbackRecommended`，提交事务按钮禁用，状态栏提示建议回滚。新增行在 `tableRowInserter`、`sourceInsertable` 且当前对象为真实表时启用，并在当前页底部创建本地草稿行。保存/撤回由 tab runtime state 中的 DataTable change set 控制；删除在 `tableRowMutator`、资源可删除且存在选中行时启用，否则保持禁用。底部状态栏在 dirty 时显示 `DML` 按钮，调用 `preview_table_change_set` 并通过 Drawer 展示即将执行的 SQL。

---

## 9. 文件索引

| 文件 | 职责 |
|------|------|
| `src/types/ipc.ts` | TS IPC 类型 |
| `src/lib/api-client.ts` | `apiInvoke` |
| `src/lib/query-keys.ts` | Query key 工厂 |
| `src/lib/schema-mutation-capabilities.ts` | 具体 schema object/operation capability 谓词 |
| `src/lib/clickhouse-schema-client.ts` | ClickHouse strong typed Describe/Create/ALTER/Column Action/Drop transport seam 与 Tauri adapter |
| `src/lib/clickhouse-view-schema-client.ts` | ClickHouse View support/Describe/Create/Alter/Rename/Drop/Temporary session transport seam |
| `src/types/ipc/clickhouse-view-schema.ts` | 七类 View family、scope、support、baseline、result 与 Cluster redacted contract |
| `src/hooks/queries/use-db-metadata.ts` | TanStack Query hooks |
| `src/features/workbench/content/schema-designer-surface-registry.ts` | driver/object/mode/capability 到 schema designer surface 的注册路由 |
| `src/store/slices/connection-session-slice.ts` | 连接 session 状态 |
| `src/store/slices/content-toolbar-slice.ts` | active tab 工具栏动作状态 |
| `src/store/slices/tab-runtime-state-slice.ts` | DataTable / SQL editor / ClickHouse Table/View native schema design / KeyValueView 的 tab 内运行时状态 |
| `src/store/slices/workbench-tabs-slice.ts` | Tab 生命周期与 `close_tab_runtime` |
| `src-tauri/src/commands/engine_commands.rs` | Engine IPC |
| `src-tauri/src/engine/types.rs` | Rust IPC 类型 |
