import { create } from "zustand";

import type {
    IAppError,
    ClickHouseTableSchema,
    QueryResult,
    RedisEditableValue,
    SqlExecutionOutcome,
    SqlExecutionSnapshot,
    SqlExecutionState,
    SqlResultMode,
    TablePageStats,
    TableRowLocator,
    TableTransactionState,
} from "@/types/ipc";
import type { SqlExecutionContext } from "@/types/saved-queries";
import type { ClickHouseViewDesignRuntimeState } from "@/types/clickhouse-view-design";
import type {
    ClickHouseColumnActionDraft,
    ClickHouseTableCreateDraft,
    ClickHouseTableEditDraft,
    ClickHouseTableObjectActionDraft,
} from "@/types/clickhouse-table-design";
import type { TableSchemaDraft } from "@/types/table-design";

export const DEFAULT_SQL_EDITOR_PAGE_SIZE = 100;
export const DEFAULT_TABLE_DATA_PAGE_SIZE = 100;

export interface TableDataEditingCellState {
    rowIndex: number;
    columnId: string;
    value: unknown;
}

export interface TableDataSelectedCellState {
    rowIndex: number;
    columnId: string;
}

export interface PendingTableRowUpdate {
    locator: TableRowLocator;
    changes: Record<string, unknown>;
}

export interface PendingTableRowInsert {
    draftId: string;
    values: Record<string, unknown>;
}

export interface TableDataChangeSet {
    inserts: Record<string, PendingTableRowInsert>;
    updates: Record<string, PendingTableRowUpdate>;
    deletes: Record<string, TableRowLocator>;
}

export type TableTransactionWarning = "rollbackRecommended" | null;

export interface TableDesignRuntimeState {
    draft: TableSchemaDraft;
    snapshot: TableSchemaDraft;
}

export type ClickHouseTableDesignRuntimeState =
    | {
          mode: "create";
          draft: ClickHouseTableCreateDraft;
          snapshot: ClickHouseTableCreateDraft;
          conflictRemoteSchema: null;
          pendingColumnAction: null;
      }
    | {
          mode: "edit";
          draft: ClickHouseTableEditDraft;
          snapshot: ClickHouseTableEditDraft;
          conflictRemoteSchema: ClickHouseTableSchema | null;
          pendingColumnAction: ClickHouseColumnActionDraft | null;
          pendingObjectAction: ClickHouseTableObjectActionDraft | null;
      };

export type SchemaDesignLoadState =
    | "loading"
    | "ready"
    | "restricted"
    | "readonly"
    | "sessionExpired"
    | "error";

export type SchemaDesignOperationState =
    | "idle"
    | "previewing"
    | "previewReady"
    | "applying"
    | "backgroundRunning"
    | "submitted"
    | "partiallyApplied"
    | "conflict"
    | "clusterDrift"
    | "outcomeUnknown";

export interface SchemaDesignRuntimeState {
    mode: "create" | "edit";
    loadState: SchemaDesignLoadState;
    operationState: SchemaDesignOperationState;
    blockerCount: number;
    errorMessage: string | null;
    isDirty: boolean;
}

type TableDesignRuntimePatch =
    | Partial<TableDesignRuntimeState>
    | ((current: TableDesignRuntimeState) => Partial<TableDesignRuntimeState>);

type ClickHouseTableDesignRuntimeInitial =
    | {
          mode: "create";
          draft: ClickHouseTableCreateDraft;
          snapshot?: ClickHouseTableCreateDraft;
      }
    | {
          mode: "edit";
          draft: ClickHouseTableEditDraft;
          snapshot?: ClickHouseTableEditDraft;
          conflictRemoteSchema?: ClickHouseTableSchema | null;
          pendingColumnAction?: ClickHouseColumnActionDraft | null;
          pendingObjectAction?: ClickHouseTableObjectActionDraft | null;
      };

type ClickHouseTableDesignRuntimePatch =
    | ({ mode: "create" } & Partial<
          Omit<
              Extract<ClickHouseTableDesignRuntimeState, { mode: "create" }>,
              "mode"
          >
      >)
    | ({ mode: "edit" } & Partial<
          Omit<
              Extract<ClickHouseTableDesignRuntimeState, { mode: "edit" }>,
              "mode"
          >
      >)
    | ((
          current: ClickHouseTableDesignRuntimeState,
      ) =>
          | ({ mode: "create" } & Partial<
                Omit<
                    Extract<
                        ClickHouseTableDesignRuntimeState,
                        { mode: "create" }
                    >,
                    "mode"
                >
            >)
          | ({ mode: "edit" } & Partial<
                Omit<
                    Extract<
                        ClickHouseTableDesignRuntimeState,
                        { mode: "edit" }
                    >,
                    "mode"
                >
            >));

export interface TableDataRuntimeState {
    page: number;
    pageSize: number;
    selectedRowIndexes: number[];
    currentRowIndex: number | null;
    selectedCell: TableDataSelectedCellState | null;
    editingCell: TableDataEditingCellState | null;
    pendingDeleteKeys: TableRowLocator[] | null;
    pendingRefreshDiscard: boolean;
    changeSet: TableDataChangeSet;
    transactionState: TableTransactionState;
    transactionWarning: TableTransactionWarning;
    pageStats: TablePageStats | null;
    pageStatsQueryKey: string | null;
    isPageInputEditing: boolean;
    pageInputValue: string;
}

export interface KeyValueRuntimeState {
    cursor: number;
    activeKey: string | null;
    collapsedFolderIds: Set<string>;
    collapsedFolderTreeKey: string | null;
    isPreviewCollapsed: boolean;
    stringPreviewMode: "text" | "json" | "xml" | null;
    valueDraft: KeyValueEditableDraft | null;
    isCreateDialogOpen: boolean;
    createDraft: KeyValueCreateDraft | null;
    pendingDeleteTarget: KeyValuePendingDeleteTarget | null;
    pendingKeySwitch: string | null;
    pendingRefreshDiscard: KeyValuePendingRefreshAction;
}

export interface SqlEditorSavedSnapshot {
    title: string;
    sqlText: string;
    context: SqlExecutionContext;
}

export interface SqlEditorExecutionSnapshot {
    sql: string;
    context: SqlExecutionContext;
    page: number;
    pageSize: number;
    resultMode: SqlResultMode;
}

export type SqlScriptStatementStatus =
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "timedOut"
    | "canceled"
    | "cancelFailed"
    | "skipped";

export interface SqlScriptStatementSourceRange {
    startOffset: number;
    endOffset: number;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

export interface SqlScriptStatementResult {
    id: string;
    index: number;
    sql: string;
    range: SqlScriptStatementSourceRange;
    status: SqlScriptStatementStatus;
    executionId: string | null;
    queryId: string | null;
    snapshot: SqlExecutionSnapshot | null;
    outcome: SqlExecutionOutcome | null;
    error: IAppError | null;
    startedAt: number | null;
    finishedAt: number | null;
    elapsedMs: number | null;
}

export interface SqlScriptExecutionBatch {
    id: string;
    mode: "script";
    context: SqlExecutionContext;
    pageSize: number;
    startedAt: number;
    finishedAt: number | null;
    activeStatementId: string | null;
    selectedStatementId: string | null;
    stopRequested: boolean;
    cancelRequested: boolean;
    summaryLabel: string;
    statements: SqlScriptStatementResult[];
}

export type SqlExecutionTimeoutMs =
    | 30_000
    | 60_000
    | 300_000
    | 900_000
    | 3_600_000
    | null;

export interface SqlEditorExecutionOptionsState {
    timeoutMs: SqlExecutionTimeoutMs;
    resultMode: SqlResultMode;
}

export interface SqlExecutionTimelineEntry {
    executionId: string;
    revision: number;
    state: SqlExecutionState;
    observedAt: number;
}

export interface SqlEditorRuntimeState {
    sqlText: string;
    context: SqlExecutionContext;
    savedSnapshot: SqlEditorSavedSnapshot | null;
    result: QueryResult | null;
    error: IAppError | null;
    lastExecution: SqlEditorExecutionSnapshot | null;
    scriptBatch: SqlScriptExecutionBatch | null;
    activeExecution: SqlExecutionSnapshot | null;
    lastOutcome: SqlExecutionOutcome | null;
    executionTimeline: SqlExecutionTimelineEntry[];
    executionOptions: SqlEditorExecutionOptionsState;
    executionDetailOpen: boolean;
    page: number;
    pageSize: number;
    isSaveDialogOpen: boolean;
    resultPanelCollapsed: boolean;
    resultPanelSize: number;
}

export type KeyValuePendingRefreshAction = "all" | "current" | null;

export type KeyValueEditableDraftValue = Extract<
    RedisEditableValue,
    { kind: "string" | "json" | "hash" | "list" | "set" | "sorted_set" | "stream" }
>;

export interface KeyValueEditableDraft {
    sourceKey: string;
    baseKey: string;
    keyDraft: string;
    baselineFingerprint: string;
    valueKind: KeyValueEditableDraftValue["kind"];
    baseValue: KeyValueEditableDraftValue;
    valueDraft: KeyValueEditableDraftValue;
}

export interface KeyValueCreateDraft {
    keyDraft: string;
    valueKind: KeyValueEditableDraftValue["kind"];
    valueDraft: KeyValueEditableDraftValue;
    ttlSecondsDraft: string;
}

export type KeyValuePendingDeleteTarget =
    | {
          kind: "key";
          key: string;
          label: string;
          expectedFingerprint?: string;
      }
    | {
          kind: "prefix";
          prefix: string;
          pattern: string;
          label: string;
          keyCount: number;
    };

export const EMPTY_TABLE_DESIGN_DRAFT: TableSchemaDraft = {
    basics: {
        tableName: "",
        databaseName: "",
        schemaName: "",
        engine: "",
        charset: "",
        collation: "",
        comment: "",
        partitionExpression: "",
        partitionRawClause: "",
        partitionReadonlyDescription: "",
    },
    columns: [],
    indexes: [],
    constraints: [],
};

type RuntimeStatePatch<T> = Partial<T> | ((current: T) => Partial<T>);
type ChangeSetPatch =
    | TableDataChangeSet
    | ((current: TableDataChangeSet) => TableDataChangeSet);

export const EMPTY_TABLE_DATA_CHANGE_SET: TableDataChangeSet = {
    inserts: {},
    updates: {},
    deletes: {},
};

function normalizeSqlExecutionContext(
    context?: SqlExecutionContext | null,
): SqlExecutionContext {
    return {
        database: context?.database?.trim() || null,
        schema: context?.schema?.trim() || null,
    };
}

function createSqlEditorRuntimeState(
    initial?: Partial<SqlEditorRuntimeState>,
): SqlEditorRuntimeState {
    return {
        sqlText: initial?.sqlText ?? "",
        context: normalizeSqlExecutionContext(initial?.context),
        savedSnapshot: initial?.savedSnapshot ?? null,
        result: initial?.result ?? null,
        error: initial?.error ?? null,
        lastExecution: initial?.lastExecution ?? null,
        scriptBatch: initial?.scriptBatch ?? null,
        activeExecution: initial?.activeExecution ?? null,
        lastOutcome: initial?.lastOutcome ?? null,
        executionTimeline: initial?.executionTimeline ?? [],
        executionOptions: initial?.executionOptions ?? {
            timeoutMs: 30_000,
            resultMode: "grid",
        },
        executionDetailOpen: initial?.executionDetailOpen ?? false,
        page: initial?.page ?? 1,
        pageSize: initial?.pageSize ?? DEFAULT_SQL_EDITOR_PAGE_SIZE,
        isSaveDialogOpen: initial?.isSaveDialogOpen ?? false,
        resultPanelCollapsed: initial?.resultPanelCollapsed ?? true,
        resultPanelSize: initial?.resultPanelSize ?? 35,
    };
}

function createTableDataRuntimeState(): TableDataRuntimeState {
    return {
        page: 1,
        pageSize: DEFAULT_TABLE_DATA_PAGE_SIZE,
        selectedRowIndexes: [],
        currentRowIndex: null,
        selectedCell: null,
        editingCell: null,
        pendingDeleteKeys: null,
        pendingRefreshDiscard: false,
        changeSet: EMPTY_TABLE_DATA_CHANGE_SET,
        transactionState: {
            inTransaction: false,
            database: null,
        },
        transactionWarning: null,
        pageStats: null,
        pageStatsQueryKey: null,
        isPageInputEditing: false,
        pageInputValue: "1",
    };
}

function cloneTableDesignDraft(draft: TableSchemaDraft): TableSchemaDraft {
    return {
        basics: { ...draft.basics },
        columns: draft.columns.map((column) => ({ ...column })),
        indexes: draft.indexes.map((index) => ({ ...index })),
        constraints: draft.constraints.map((constraint) => ({ ...constraint })),
    };
}

function createEmptyTableDesignDraft(): TableSchemaDraft {
    return cloneTableDesignDraft(EMPTY_TABLE_DESIGN_DRAFT);
}

function createTableDesignRuntimeState(
    initial?: Partial<TableDesignRuntimeState>,
): TableDesignRuntimeState {
    const draft = initial?.draft ? cloneTableDesignDraft(initial.draft) : createEmptyTableDesignDraft();
    const snapshot = initial?.snapshot ? cloneTableDesignDraft(initial.snapshot) : cloneTableDesignDraft(draft);
    return {
        draft,
        snapshot,
    };
}

function cloneClickHouseTableDesignDraft(
    draft: ClickHouseTableCreateDraft,
): ClickHouseTableCreateDraft {
    return {
        ...draft,
        columns: draft.columns.map((column) => ({
            ...column,
            codecs: column.codecs.map((codec) => ({
                ...codec,
                arguments: [...codec.arguments],
            })),
        })),
        engineArguments: [...draft.engineArguments],
        settings: draft.settings.map((setting) => ({ ...setting })),
    };
}

function cloneClickHouseTableSchema(
    schema: ClickHouseTableSchema,
): ClickHouseTableSchema {
    const cloneEditability = (
        editability: ClickHouseTableSchema["editability"],
    ): ClickHouseTableSchema["editability"] => ({
        ...editability,
        blockers: editability.blockers.map((blocker) => ({ ...blocker })),
    });

    return {
        ...schema,
        identity: { ...schema.identity },
        engine: {
            ...schema.engine,
            arguments: [...schema.engine.arguments],
        },
        columns: schema.columns.map((column) => ({
            ...column,
            editability: cloneEditability(column.editability),
        })),
        keys: { ...schema.keys },
        settings: schema.settings.map((setting) => ({ ...setting })),
        projections: schema.projections.map((projection) => ({
            ...projection,
            editability: cloneEditability(projection.editability),
        })),
        skippingIndexes: schema.skippingIndexes.map((index) => ({
            ...index,
            typeArguments: [...index.typeArguments],
            editability: cloneEditability(index.editability),
        })),
        editability: cloneEditability(schema.editability),
        baseline: { ...schema.baseline },
    };
}

function cloneClickHouseTableEditDraft(
    draft: ClickHouseTableEditDraft,
): ClickHouseTableEditDraft {
    const table = cloneClickHouseTableDesignDraft(draft.table);
    return {
        table,
        baseline: cloneClickHouseTableSchema(draft.baseline),
        sourceColumnNameById: Object.fromEntries(
            table.columns.map((column) => [
                column.id,
                draft.sourceColumnNameById[column.id] ?? null,
            ]),
        ),
    };
}

function cloneClickHouseTableObjectAction(
    action: ClickHouseTableObjectActionDraft,
): ClickHouseTableObjectActionDraft {
    if (action.objectKind === "projection") {
        return {
            ...action,
            definition: action.definition ? { ...action.definition } : null,
        };
    }
    return {
        ...action,
        definition: action.definition
            ? {
                  ...action.definition,
                  typeArguments: [...action.definition.typeArguments],
              }
            : null,
    };
}

function createClickHouseTableDesignRuntimeState(
    initial: ClickHouseTableDesignRuntimeInitial,
): ClickHouseTableDesignRuntimeState {
    if (initial.mode === "create") {
        const draft = cloneClickHouseTableDesignDraft(initial.draft);
        return {
            mode: "create",
            draft,
            snapshot: initial.snapshot
                ? cloneClickHouseTableDesignDraft(initial.snapshot)
                : cloneClickHouseTableDesignDraft(draft),
            conflictRemoteSchema: null,
            pendingColumnAction: null,
        };
    }

    const draft = cloneClickHouseTableEditDraft(initial.draft);
    return {
        mode: "edit",
        draft,
        snapshot: initial.snapshot
            ? cloneClickHouseTableEditDraft(initial.snapshot)
            : cloneClickHouseTableEditDraft(draft),
        conflictRemoteSchema: initial.conflictRemoteSchema
            ? cloneClickHouseTableSchema(initial.conflictRemoteSchema)
            : null,
        pendingColumnAction: initial.pendingColumnAction
            ? { ...initial.pendingColumnAction }
            : null,
        pendingObjectAction: initial.pendingObjectAction
            ? cloneClickHouseTableObjectAction(initial.pendingObjectAction)
            : null,
    };
}

function createSchemaDesignRuntimeState(
    initial?: Partial<SchemaDesignRuntimeState>,
): SchemaDesignRuntimeState {
    return {
        mode: initial?.mode ?? "edit",
        loadState: initial?.loadState ?? "loading",
        operationState: initial?.operationState ?? "idle",
        blockerCount: initial?.blockerCount ?? 0,
        errorMessage: initial?.errorMessage ?? null,
        isDirty: initial?.isDirty ?? false,
    };
}

function createKeyValueRuntimeState(activeKey?: string | null): KeyValueRuntimeState {
    return {
        cursor: 0,
        activeKey: activeKey ?? null,
        collapsedFolderIds: new Set(),
        collapsedFolderTreeKey: null,
        isPreviewCollapsed: activeKey == null,
        stringPreviewMode: null,
        valueDraft: null,
        isCreateDialogOpen: false,
        createDraft: null,
        pendingDeleteTarget: null,
        pendingKeySwitch: null,
        pendingRefreshDiscard: null,
    };
}

function resolvePatch<T>(current: T, patch: RuntimeStatePatch<T>): Partial<T> {
    return typeof patch === "function" ? patch(current) : patch;
}

interface TabRuntimeStateStore {
    sqlEditorByTabId: Record<string, SqlEditorRuntimeState>;
    tableDataByTabId: Record<string, TableDataRuntimeState>;
    tableDesignByTabId: Record<string, TableDesignRuntimeState>;
    clickHouseTableDesignByTabId: Record<
        string,
        ClickHouseTableDesignRuntimeState
    >;
    clickHouseViewDesignByTabId: Record<
        string,
        ClickHouseViewDesignRuntimeState
    >;
    schemaDesignByTabId: Record<string, SchemaDesignRuntimeState>;
    keyValueByTabId: Record<string, KeyValueRuntimeState>;

    getOrCreateSqlEditorState: (
        tabId: string,
        initial?: Partial<SqlEditorRuntimeState>,
    ) => SqlEditorRuntimeState;
    patchSqlEditorState: (
        tabId: string,
        patch: RuntimeStatePatch<SqlEditorRuntimeState>,
    ) => void;

    getOrCreateTableDataState: (tabId: string) => TableDataRuntimeState;
    patchTableDataState: (
        tabId: string,
        patch: RuntimeStatePatch<TableDataRuntimeState>,
    ) => void;
    setTableDataChangeSet: (tabId: string, patch: ChangeSetPatch) => void;
    resetTableDataTransientState: (tabId: string) => void;
    clearTableDataChangeSet: (tabId: string) => void;

    getOrCreateTableDesignState: (
        tabId: string,
        initial?: Partial<TableDesignRuntimeState>,
    ) => TableDesignRuntimeState;
    patchTableDesignState: (
        tabId: string,
        patch: TableDesignRuntimePatch,
    ) => void;
    resetTableDesignDraft: (tabId: string) => void;

    getOrCreateClickHouseTableDesignState: (
        tabId: string,
        initial: ClickHouseTableDesignRuntimeInitial,
    ) => ClickHouseTableDesignRuntimeState;
    patchClickHouseTableDesignState: (
        tabId: string,
        patch: ClickHouseTableDesignRuntimePatch,
    ) => void;
    resetClickHouseTableDesignDraft: (tabId: string) => void;
    removeClickHouseTableDesignState: (tabId: string) => void;

    getOrCreateClickHouseViewDesignState: (
        tabId: string,
        initial: ClickHouseViewDesignRuntimeState,
    ) => ClickHouseViewDesignRuntimeState;
    patchClickHouseViewDesignState: (
        tabId: string,
        patch: RuntimeStatePatch<ClickHouseViewDesignRuntimeState>,
    ) => void;
    removeClickHouseViewDesignState: (tabId: string) => void;

    getOrCreateSchemaDesignState: (
        tabId: string,
        initial?: Partial<SchemaDesignRuntimeState>,
    ) => SchemaDesignRuntimeState;
    patchSchemaDesignState: (
        tabId: string,
        patch: RuntimeStatePatch<SchemaDesignRuntimeState>,
    ) => void;
    removeSchemaDesignState: (tabId: string) => void;

    getOrCreateKeyValueState: (
        tabId: string,
        initial?: Partial<Pick<KeyValueRuntimeState, "activeKey">>,
    ) => KeyValueRuntimeState;
    patchKeyValueState: (
        tabId: string,
        patch: RuntimeStatePatch<KeyValueRuntimeState>,
    ) => void;

    removeTabRuntimeState: (tabId: string) => void;
}

export const useTabRuntimeStateStore = create<TabRuntimeStateStore>((set, get) => ({
    sqlEditorByTabId: {},
    tableDataByTabId: {},
    tableDesignByTabId: {},
    clickHouseTableDesignByTabId: {},
    clickHouseViewDesignByTabId: {},
    schemaDesignByTabId: {},
    keyValueByTabId: {},

    getOrCreateSqlEditorState: (tabId, initial) => {
        const existing = get().sqlEditorByTabId[tabId];
        if (existing) return existing;

        const nextState = createSqlEditorRuntimeState(initial);
        set((state) => ({
            sqlEditorByTabId: {
                ...state.sqlEditorByTabId,
                [tabId]: nextState,
            },
        }));
        return nextState;
    },

    patchSqlEditorState: (tabId, patch) => {
        set((state) => {
            const current =
                state.sqlEditorByTabId[tabId] ?? createSqlEditorRuntimeState();
            return {
                sqlEditorByTabId: {
                    ...state.sqlEditorByTabId,
                    [tabId]: {
                        ...current,
                        ...resolvePatch(current, patch),
                    },
                },
            };
        });
    },

    getOrCreateTableDataState: (tabId) => {
        const existing = get().tableDataByTabId[tabId];
        if (existing) return existing;

        const nextState = createTableDataRuntimeState();
        set((state) => ({
            tableDataByTabId: {
                ...state.tableDataByTabId,
                [tabId]: nextState,
            },
        }));
        return nextState;
    },

    patchTableDataState: (tabId, patch) => {
        set((state) => {
            const current =
                state.tableDataByTabId[tabId] ?? createTableDataRuntimeState();
            return {
                tableDataByTabId: {
                    ...state.tableDataByTabId,
                    [tabId]: {
                        ...current,
                        ...resolvePatch(current, patch),
                    },
                },
            };
        });
    },

    setTableDataChangeSet: (tabId, patch) => {
        set((state) => {
            const current =
                state.tableDataByTabId[tabId] ?? createTableDataRuntimeState();
            const nextChangeSet =
                typeof patch === "function" ? patch(current.changeSet) : patch;
            return {
                tableDataByTabId: {
                    ...state.tableDataByTabId,
                    [tabId]: {
                        ...current,
                        changeSet: nextChangeSet,
                    },
                },
            };
        });
    },

    resetTableDataTransientState: (tabId) => {
        get().patchTableDataState(tabId, {
            selectedRowIndexes: [],
            currentRowIndex: null,
            selectedCell: null,
            editingCell: null,
            pendingDeleteKeys: null,
            pendingRefreshDiscard: false,
        });
    },

    clearTableDataChangeSet: (tabId) => {
        get().patchTableDataState(tabId, {
            changeSet: EMPTY_TABLE_DATA_CHANGE_SET,
        });
    },

    getOrCreateTableDesignState: (tabId, initial) => {
        const existing = get().tableDesignByTabId[tabId];
        if (existing) return existing;

        const nextState = createTableDesignRuntimeState(initial);
        set((state) => ({
            tableDesignByTabId: {
                ...state.tableDesignByTabId,
                [tabId]: nextState,
            },
        }));
        return nextState;
    },

    patchTableDesignState: (tabId, patch) => {
        set((state) => {
            const current =
                state.tableDesignByTabId[tabId] ?? createTableDesignRuntimeState();
            const nextPatch =
                typeof patch === "function" ? patch(current) : patch;

            return {
                tableDesignByTabId: {
                    ...state.tableDesignByTabId,
                    [tabId]: {
                        ...current,
                        ...nextPatch,
                        draft: nextPatch.draft
                            ? cloneTableDesignDraft(nextPatch.draft)
                            : current.draft,
                        snapshot: nextPatch.snapshot
                            ? cloneTableDesignDraft(nextPatch.snapshot)
                            : current.snapshot,
                    },
                },
            };
        });
    },

    resetTableDesignDraft: (tabId) => {
        set((state) => {
            const current =
                state.tableDesignByTabId[tabId] ?? createTableDesignRuntimeState();

            return {
                tableDesignByTabId: {
                    ...state.tableDesignByTabId,
                    [tabId]: {
                        ...current,
                        draft: cloneTableDesignDraft(current.snapshot),
                    },
                },
            };
        });
    },

    getOrCreateClickHouseTableDesignState: (tabId, initial) => {
        const existing = get().clickHouseTableDesignByTabId[tabId];
        if (existing) return existing;

        const nextState = createClickHouseTableDesignRuntimeState(initial);
        set((state) => ({
            clickHouseTableDesignByTabId: {
                ...state.clickHouseTableDesignByTabId,
                [tabId]: nextState,
            },
        }));
        return nextState;
    },

    patchClickHouseTableDesignState: (tabId, patch) => {
        set((state) => {
            const current = state.clickHouseTableDesignByTabId[tabId];
            if (!current) {
                throw new Error(
                    `ClickHouse table design state is not initialized for tab ${tabId}`,
                );
            }
            const nextPatch =
                typeof patch === "function" ? patch(current) : patch;
            if (nextPatch.mode === "create") {
                if (current.mode !== "create") {
                    throw new Error(
                        `Cannot patch ClickHouse edit state as create for tab ${tabId}`,
                    );
                }
                return {
                    clickHouseTableDesignByTabId: {
                        ...state.clickHouseTableDesignByTabId,
                        [tabId]: {
                            mode: "create",
                            draft: nextPatch.draft
                                ? cloneClickHouseTableDesignDraft(
                                      nextPatch.draft,
                                  )
                                : current.draft,
                            snapshot: nextPatch.snapshot
                                ? cloneClickHouseTableDesignDraft(
                                      nextPatch.snapshot,
                                  )
                                : current.snapshot,
                            conflictRemoteSchema: null,
                            pendingColumnAction: null,
                        },
                    },
                };
            }
            if (current.mode !== "edit") {
                throw new Error(
                    `Cannot patch ClickHouse create state as edit for tab ${tabId}`,
                );
            }
            return {
                clickHouseTableDesignByTabId: {
                    ...state.clickHouseTableDesignByTabId,
                    [tabId]: {
                        mode: "edit",
                        draft: nextPatch.draft
                            ? cloneClickHouseTableEditDraft(nextPatch.draft)
                            : current.draft,
                        snapshot: nextPatch.snapshot
                            ? cloneClickHouseTableEditDraft(nextPatch.snapshot)
                            : current.snapshot,
                        conflictRemoteSchema:
                            nextPatch.conflictRemoteSchema === undefined
                                ? current.conflictRemoteSchema
                                : nextPatch.conflictRemoteSchema
                                  ? cloneClickHouseTableSchema(
                                        nextPatch.conflictRemoteSchema,
                                    )
                                  : null,
                        pendingColumnAction:
                            nextPatch.pendingColumnAction === undefined
                                ? current.pendingColumnAction
                                : nextPatch.pendingColumnAction
                                  ? { ...nextPatch.pendingColumnAction }
                                  : null,
                        pendingObjectAction:
                            nextPatch.pendingObjectAction === undefined
                                ? current.pendingObjectAction
                                : nextPatch.pendingObjectAction
                                  ? cloneClickHouseTableObjectAction(
                                        nextPatch.pendingObjectAction,
                                    )
                                  : null,
                    },
                },
            };
        });
    },

    resetClickHouseTableDesignDraft: (tabId) => {
        set((state) => {
            const current = state.clickHouseTableDesignByTabId[tabId];
            if (!current) return state;
            if (current.mode === "create") {
                return {
                    clickHouseTableDesignByTabId: {
                        ...state.clickHouseTableDesignByTabId,
                        [tabId]: {
                            ...current,
                            draft: cloneClickHouseTableDesignDraft(
                                current.snapshot,
                            ),
                            conflictRemoteSchema: null,
                            pendingColumnAction: null,
                        },
                    },
                };
            }
            return {
                clickHouseTableDesignByTabId: {
                    ...state.clickHouseTableDesignByTabId,
                    [tabId]: {
                        ...current,
                        draft: cloneClickHouseTableEditDraft(current.snapshot),
                        conflictRemoteSchema: null,
                        pendingColumnAction: null,
                        pendingObjectAction: null,
                    },
                },
            };
        });
    },

    removeClickHouseTableDesignState: (tabId) => {
        set((state) => {
            const clickHouseTableDesignByTabId = {
                ...state.clickHouseTableDesignByTabId,
            };
            delete clickHouseTableDesignByTabId[tabId];
            return { clickHouseTableDesignByTabId };
        });
    },

    getOrCreateClickHouseViewDesignState: (tabId, initial) => {
        const existing = get().clickHouseViewDesignByTabId[tabId];
        if (existing) return existing;
        set((state) => ({
            clickHouseViewDesignByTabId: {
                ...state.clickHouseViewDesignByTabId,
                [tabId]: initial,
            },
        }));
        return initial;
    },

    patchClickHouseViewDesignState: (tabId, patch) => {
        set((state) => {
            const current = state.clickHouseViewDesignByTabId[tabId];
            if (!current) return state;
            return {
                clickHouseViewDesignByTabId: {
                    ...state.clickHouseViewDesignByTabId,
                    [tabId]: {
                        ...current,
                        ...resolvePatch(current, patch),
                    },
                },
            };
        });
    },

    removeClickHouseViewDesignState: (tabId) => {
        set((state) => {
            const clickHouseViewDesignByTabId = {
                ...state.clickHouseViewDesignByTabId,
            };
            delete clickHouseViewDesignByTabId[tabId];
            return { clickHouseViewDesignByTabId };
        });
    },

    getOrCreateSchemaDesignState: (tabId, initial) => {
        const existing = get().schemaDesignByTabId[tabId];
        if (existing) return existing;

        const nextState = createSchemaDesignRuntimeState(initial);
        set((state) => ({
            schemaDesignByTabId: {
                ...state.schemaDesignByTabId,
                [tabId]: nextState,
            },
        }));
        return nextState;
    },

    patchSchemaDesignState: (tabId, patch) => {
        set((state) => {
            const current =
                state.schemaDesignByTabId[tabId] ??
                createSchemaDesignRuntimeState();
            return {
                schemaDesignByTabId: {
                    ...state.schemaDesignByTabId,
                    [tabId]: {
                        ...current,
                        ...resolvePatch(current, patch),
                    },
                },
            };
        });
    },

    removeSchemaDesignState: (tabId) => {
        set((state) => {
            const schemaDesignByTabId = { ...state.schemaDesignByTabId };
            delete schemaDesignByTabId[tabId];
            return { schemaDesignByTabId };
        });
    },

    getOrCreateKeyValueState: (tabId, initial) => {
        const existing = get().keyValueByTabId[tabId];
        if (existing) return existing;

        const nextState = createKeyValueRuntimeState(initial?.activeKey);
        set((state) => ({
            keyValueByTabId: {
                ...state.keyValueByTabId,
                [tabId]: nextState,
            },
        }));
        return nextState;
    },

    patchKeyValueState: (tabId, patch) => {
        set((state) => {
            const current =
                state.keyValueByTabId[tabId] ?? createKeyValueRuntimeState();
            return {
                keyValueByTabId: {
                    ...state.keyValueByTabId,
                    [tabId]: {
                        ...current,
                        ...resolvePatch(current, patch),
                    },
                },
            };
        });
    },

    removeTabRuntimeState: (tabId) => {
        set((state) => {
            const sqlEditorByTabId = { ...state.sqlEditorByTabId };
            const tableDataByTabId = { ...state.tableDataByTabId };
            const tableDesignByTabId = { ...state.tableDesignByTabId };
            const clickHouseTableDesignByTabId = {
                ...state.clickHouseTableDesignByTabId,
            };
            const clickHouseViewDesignByTabId = {
                ...state.clickHouseViewDesignByTabId,
            };
            const schemaDesignByTabId = { ...state.schemaDesignByTabId };
            const keyValueByTabId = { ...state.keyValueByTabId };
            delete sqlEditorByTabId[tabId];
            delete tableDataByTabId[tabId];
            delete tableDesignByTabId[tabId];
            delete clickHouseTableDesignByTabId[tabId];
            delete clickHouseViewDesignByTabId[tabId];
            delete schemaDesignByTabId[tabId];
            delete keyValueByTabId[tabId];
            return {
                sqlEditorByTabId,
                tableDataByTabId,
                tableDesignByTabId,
                clickHouseTableDesignByTabId,
                clickHouseViewDesignByTabId,
                schemaDesignByTabId,
                keyValueByTabId,
            };
        });
    },
}));
