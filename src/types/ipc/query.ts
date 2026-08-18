import type { ErrorCode, RuntimeErrorImpact } from "@/types/ipc/errors";
import type { SqlExecutionContext } from "@/types/saved-queries";

export type ColumnDataCategory =
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "time"
    | "datetime"
    | "json"
    | "structured"
    | "enum"
    | "binary"
    | "uuid"
    | "unknown";

export interface ColumnMeta {
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

export interface QueryResult {
    columns: ColumnMeta[];
    /** 每一行都是一个和 columns 顺序一致的 JSON 值列表；精确 bigint 等值可能以字符串传输。 */
    rows: unknown[][];
    /** DML 语句有该字段，SELECT 时为 undefined。 */
    affectedRows?: number;
    /** 是否还有更多分页数据。 */
    hasNextPage: boolean;
    /** 数据来源是否整体可写。真实表且至少具备主键时才为 true。 */
    sourceWritable: boolean;
    /** 数据来源是否允许新增行；不同于 update/delete 所需的主键可写性。 */
    sourceInsertable: boolean;
    /** 当前数据来源的主键列名，按主键顺序排列。 */
    primaryKeyColumns: string[];
    /** 当前浏览结果使用的稳定排序列。无主键时为空。 */
    stableOrderColumns: string[];
    /** DataTable 对已有行进行 update/delete 时使用的行定位策略。 */
    rowLocatorStrategy?: TableRowLocatorStrategy | null;
}

export type TableBrowseScalar = string | number | boolean;

export type TableBrowseFilter =
    | {
        column: string;
        operator:
            | "eq"
            | "not_eq"
            | "gt"
            | "gte"
            | "lt"
            | "lte";
        value: TableBrowseScalar;
    }
    | {
        column: string;
        operator: "is_null" | "is_not_null";
        value?: never;
    };

export interface TableBrowseSort {
    column: string;
    direction: "asc" | "desc";
}

export interface TableBrowseQuery {
    filters: TableBrowseFilter[];
    sort: TableBrowseSort[];
}

export type JsonSafeInteger = number | string;

export type SqlExecutionState =
    | "queued"
    | "starting"
    | "running"
    | "canceling"
    | "succeeded"
    | "failed"
    | "timedOut"
    | "canceled"
    | "cancelFailed";

export type SqlStatementClass =
    | "read"
    | "ddl"
    | "insert"
    | "delete"
    | "mutation"
    | "system"
    | "command"
    | "unknown";

export type SqlResultMode = "grid" | "raw";

export interface SqlExecutionOptions {
    resultMode: SqlResultMode;
    timeoutMs?: number | null;
    page: number;
    pageSize: number;
}

export interface StartSqlExecutionRequest {
    context: SqlExecutionContext;
    sql: string;
    options: SqlExecutionOptions;
}

export type SqlSummarySource =
    | "livePoll"
    | "responseHeader"
    | "clientObserved"
    | "merged";

export type SqlSummaryCompleteness = "partial" | "final" | "unknown";

export interface SqlExecutionSummary {
    readRows?: JsonSafeInteger;
    readBytes?: JsonSafeInteger;
    writtenRows?: JsonSafeInteger;
    writtenBytes?: JsonSafeInteger;
    totalRowsToRead?: JsonSafeInteger;
    resultRows?: JsonSafeInteger;
    resultBytes?: JsonSafeInteger;
    elapsedNs?: JsonSafeInteger;
    memoryUsage?: JsonSafeInteger;
    source: SqlSummarySource;
    completeness: SqlSummaryCompleteness;
}

export interface SqlExecutionFailure {
    code: ErrorCode;
    runtimeImpact: RuntimeErrorImpact;
    message: string;
    details?: string | null;
}

export type SqlExecutionOutcome =
    | {
          kind: "rows";
          result: QueryResult;
      }
    | {
          kind: "command";
          statementClass: SqlStatementClass;
          completionMessage: string;
          summary: SqlExecutionSummary | null;
          mutationSubmitted: boolean;
      }
    | {
          kind: "raw";
          format: string | null;
          mediaType: string;
          byteLength: JsonSafeInteger;
          preview: string;
          previewTruncated: boolean;
          artifactId: string;
      };

export interface SqlExecutionHandle {
    executionId: string;
    queryId: string;
    tabId: string;
    state: SqlExecutionState;
    startedAt: number;
}

export interface SqlExecutionSnapshot {
    executionId: string;
    queryId: string;
    tabId: string;
    state: SqlExecutionState;
    revision: number;
    statementClass: SqlStatementClass;
    startedAt: number;
    finishedAt: number | null;
    progressAvailable: boolean;
    summary: SqlExecutionSummary | null;
    outcome: SqlExecutionOutcome | null;
    failure: SqlExecutionFailure | null;
    cancelMessage: string | null;
    observationWarnings?: string[];
}

export type SqlExecutionEvent = {
    kind: "snapshot";
    snapshot: SqlExecutionSnapshot;
};

export interface TablePageStats {
    totalRows: JsonSafeInteger;
    totalPages: JsonSafeInteger;
    pageSize: number;
}

export interface TableRowKeyPart {
    column: string;
    value: unknown;
}

export type TableRowKey = TableRowKeyPart[];

export type TableRowLocatorStrategy = "primaryKey" | "rowSnapshot";

export type TableRowLocator =
    | { kind: "primaryKey"; parts: TableRowKey }
    | {
          kind: "rowSnapshot";
          parts: TableRowKey;
          expectedMatches: number;
      };

export interface TableCellChange {
    column: string;
    value: unknown;
}

export interface TableMutationResult {
    affectedRows: number;
}

export interface TableChangeSetUpdate {
    locator: TableRowLocator;
    changes: TableCellChange[];
}

export interface TableChangeSetInsert {
    values: TableCellChange[];
}

export interface TableChangeSetRequest {
    inserts: TableChangeSetInsert[];
    updates: TableChangeSetUpdate[];
    deletes: TableRowLocator[];
}

export interface TableChangeSetSummary {
    inserts: number;
    updates: number;
    deletes: number;
}

export interface TableChangeSetPreview {
    statements: string[];
    summary: TableChangeSetSummary;
}

export interface TableChangeSetCommitResult {
    affectedRows: number;
    preview: TableChangeSetPreview;
    outcome: TableChangeOutcome;
}

export type TableChangeOutcome =
    | "applied"
    | "submitted"
    | "outcomeUnknown"
    | "conflict";

export interface TableTransactionState {
    inTransaction: boolean;
    database?: string | null;
}
