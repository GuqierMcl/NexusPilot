import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { save as selectSaveDestination } from "@tauri-apps/plugin-dialog";
import { useGroupRef, type Layout } from "react-resizable-panels";
import { nanoid } from "nanoid";
import { toast } from "@/components/ui/toast";

import { CodeEditor, type CodeEditorOnMount } from "@/components/editor";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useContainers } from "@/hooks/queries/use-db-metadata";
import { normalizeIpcError } from "@/lib/ipc-error";
import { queryKeys } from "@/lib/query-keys";
import {
    defaultSqlExecutionTransport,
    saveSqlExecutionArtifact,
} from "@/lib/sql-execution-client";
import { createSavedQuery, updateSavedQuery } from "@/lib/tauri/saved-queries";
import {
    DEFAULT_SQL_EDITOR_PAGE_SIZE,
    useExplorerStore,
    useTabRuntimeStateStore,
    useWorkbenchTabsStore,
    type SqlEditorRuntimeState,
    type SqlExecutionTimeoutMs,
    type SqlScriptExecutionBatch,
} from "@/store";
import type { IAppError, SqlResultMode } from "@/types/ipc";
import type {
    CreateSavedQueryInput,
    SavedQuery,
    SqlExecutionContext,
    UpdateSavedQueryInput,
} from "@/types/saved-queries";

import { SaveQueryDialog } from "./SaveQueryDialog";
import { ExecutionDetailDrawer } from "./ExecutionDetailDrawer";
import {
    saveRawSqlResult,
    type RawSqlArtifactOwner,
} from "./raw-sql-result";
import { SqlExecutionTargetHint } from "./SqlExecutionTargetHint";
import {
    SqlEditorContextBar,
    type SqlEditorContextOption,
} from "./SqlEditorContextBar";
import { SqlEditorResultPanel } from "./SqlEditorResultPanel";
import {
    buildSqlEditorResultPanelLayout,
    buildSqlEditorSaveSuccessPatch,
    buildSqlCurrentStatementHint,
    buildSqlPrimaryRunHint,
    buildSqlScriptExecutionHint,
    getSqlEditorResultPanelSize,
    normalizeSqlContext,
    resolveSqlCurrentStatementTarget,
    resolveSqlPrimaryRunTarget,
    sqlEditorIsDirty,
    type SqlRunTargetSource,
} from "./sql-editor-utils";
import {
    applySqlScriptStatementSnapshot,
    createSqlScriptBatch,
    markSqlScriptBatchFinished,
    markSqlScriptRemainingSkipped,
    markSqlScriptStatementStartFailed,
    requestSqlScriptActiveCancel,
    requestSqlScriptQueueStop,
} from "./sql-script-lifecycle";
import {
    registerSqlCompletionProvider,
    triggerSqlColumnSuggestIfNeeded,
} from "./sql-monaco-completion";
import type { SqlCompletionBuildInput } from "./sql-completion";
import { useSqlCompletionMetadata } from "./useSqlCompletionMetadata";
import { useSqlEditorToolbar } from "./useSqlEditorToolbar";
import { useSqlExecutionLifecycle } from "./useSqlExecutionLifecycle";

interface SqlEditorViewProps {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    savedQueryId?: string | null;
    initialContext?: SqlExecutionContext | null;
    isActive: boolean;
}

interface SaveQueryInput {
    title: string;
    sqlText: string;
    context: SqlExecutionContext;
}

function createSqlEditorRuntimeFallback(
    context: SqlExecutionContext,
): SqlEditorRuntimeState {
    return {
        sqlText: "",
        context,
        savedSnapshot: null,
        result: null,
        error: null,
        lastExecution: null,
        scriptBatch: null,
        activeExecution: null,
        lastOutcome: null,
        executionTimeline: [],
        executionOptions: {
            timeoutMs: 30_000,
            resultMode: "grid",
        },
        executionDetailOpen: false,
        page: 1,
        pageSize: DEFAULT_SQL_EDITOR_PAGE_SIZE,
        isSaveDialogOpen: false,
        resultPanelCollapsed: true,
        resultPanelSize: 35,
    };
}

function resolveDriverName(driverName?: string | null): string {
    return driverName?.trim().toLowerCase() ?? "";
}

type SqlContextMode = {
    showDatabase: boolean;
    showSchema: boolean;
    schemaParent: "database" | "root" | "none";
};

export function resolveSqlContextMode(driverName?: string | null): SqlContextMode {
    const normalized = resolveDriverName(driverName);
    if (normalized === "postgres" || normalized === "postgresql") {
        return {
            showDatabase: true,
            showSchema: true,
            schemaParent: "database",
        };
    }
    if (normalized === "oracle") {
        return {
            showDatabase: false,
            showSchema: true,
            schemaParent: "root",
        };
    }
    return {
        showDatabase: true,
        showSchema: false,
        schemaParent: "none",
    };
}

function normalizeContextForDriver(
    context: SqlExecutionContext,
    showSchema: boolean,
): SqlExecutionContext {
    const normalized = normalizeSqlContext(context);
    return {
        database: normalized.database,
        schema: showSchema ? normalized.schema : null,
    };
}

export function SqlEditorView({
    tabId,
    profileId,
    tabRuntimeId,
    savedQueryId,
    initialContext,
    isActive,
}: SqlEditorViewProps) {
    const resultPanelGroupRef = useGroupRef();
    const sqlEditorRef = useRef<Parameters<CodeEditorOnMount>[0] | null>(null);
    const editorSelectionRef = useRef("");
    const editorCursorOffsetRef = useRef(0);
    const [editorTargetState, setEditorTargetState] = useState({
        selectedText: "",
        cursorOffset: 0,
    });
    const executionInFlightRef = useRef(false);
    const scriptStopRequestedRef = useRef(false);
    const scriptBatchRef = useRef<SqlScriptExecutionBatch | null>(null);
    const [isScriptExecuting, setIsScriptExecuting] = useState(false);
    const [isSavingRawArtifact, setIsSavingRawArtifact] = useState(false);
    const [scriptExecutionHintTarget, setScriptExecutionHintTarget] =
        useState<{
            sqlText: string;
            source: SqlRunTargetSource;
        } | null>(null);
    const completionContextRef = useRef<SqlCompletionBuildInput>({
        driverName: null,
        showSchema: false,
        databases: [],
        schemas: [],
        objects: [],
    });
    const queryClient = useQueryClient();
    const setExecuting = useWorkbenchTabsStore((state) => state.setExecuting);
    const setDirty = useWorkbenchTabsStore((state) => state.setDirty);
    const openSqlEditorTab = useWorkbenchTabsStore(
        (state) => state.openSqlEditorTab,
    );
    const openClickHouseTemporaryViewTab = useWorkbenchTabsStore(
        (state) => state.openClickHouseTemporaryViewTab,
    );
    const activeTab = useWorkbenchTabsStore(
        (state) => state.tabs.find((tab) => tab.id === tabId) ?? null,
    );
    const connection = useExplorerStore(
        (state) => state.connections.find((item) => item.id === profileId) ?? null,
    );
    const initialSqlContext = useMemo(
        () => normalizeSqlContext(initialContext),
        [initialContext?.database, initialContext?.schema],
    );
    const runtimeFallback = useMemo(
        () => createSqlEditorRuntimeFallback(initialSqlContext),
        [initialSqlContext],
    );
    const state =
        useTabRuntimeStateStore((store) => store.sqlEditorByTabId[tabId]) ??
        runtimeFallback;
    const getOrCreateSqlEditorState = useTabRuntimeStateStore(
        (store) => store.getOrCreateSqlEditorState,
    );
    const patchState = useTabRuntimeStateStore(
        (store) => store.patchSqlEditorState,
    );
    const sqlExecutionFeatures =
        activeTab?.type === "sql_editor"
            ? activeTab.payload.runtime.capabilities.sqlExecution
            : undefined;
    const lifecycle = useSqlExecutionLifecycle({
        tabId,
        runtimeTabId: tabRuntimeId,
        profileId,
        features: sqlExecutionFeatures,
    });
    const isExecuting = lifecycle.isExecuting;

    useEffect(() => {
        scriptBatchRef.current = state.scriptBatch;
    }, [state.scriptBatch]);

    useEffect(() => {
        getOrCreateSqlEditorState(tabId, {
            context: initialSqlContext,
        });
    }, [getOrCreateSqlEditorState, initialSqlContext, tabId]);

    const driverName = activeTab?.type === "sql_editor"
        ? activeTab.payload.runtime.driverName
        : connection?.driver;
    const normalizedDriverName = resolveDriverName(driverName ?? connection?.driver);
    const contextMode = useMemo(
        () => resolveSqlContextMode(normalizedDriverName),
        [normalizedDriverName],
    );
    const showDatabase = contextMode.showDatabase;
    const showSchema = contextMode.showSchema;
    const databaseQuery = useContainers(profileId, null);
    const title = activeTab?.title ?? "未命名查询";
    const effectiveContext = useMemo(
        () => normalizeContextForDriver(state.context, showSchema),
        [showSchema, state.context],
    );
    const dirtyTitle =
        savedQueryId || !state.savedSnapshot ? title : state.savedSnapshot.title;
    const isDirty = sqlEditorIsDirty({
        title: dirtyTitle,
        sqlText: state.sqlText,
        context: effectiveContext,
        savedSnapshot: state.savedSnapshot,
    });

    const selectedDatabaseContainer = databaseQuery.data?.find(
        (item) =>
            item.kind === "database" &&
            item.container.database === effectiveContext.database,
    )?.container;
    const schemaParent =
        contextMode.schemaParent === "database"
            ? selectedDatabaseContainer ?? null
            : null;
    const schemaQuery = useContainers(
        profileId,
        schemaParent,
        showSchema &&
            contextMode.schemaParent === "database" &&
            schemaParent != null,
    );
    const schemaContainers =
        contextMode.schemaParent === "root" ? databaseQuery.data : schemaQuery.data;

    const applyResultPanelLayout = useCallback(
        (collapsed: boolean, resultPanelSize = state.resultPanelSize) => {
            const layout = buildSqlEditorResultPanelLayout({
                collapsed,
                resultPanelSize,
            });
            resultPanelGroupRef.current?.setLayout(layout);
        },
        [resultPanelGroupRef, state.resultPanelSize],
    );

    const expandResultPanel = useCallback(() => {
        patchState(tabId, { resultPanelCollapsed: false });
        requestAnimationFrame(() => {
            applyResultPanelLayout(false);
        });
    }, [applyResultPanelLayout, patchState, tabId]);

    const handleToggleResultPanel = useCallback(() => {
        const nextCollapsed = !state.resultPanelCollapsed;
        patchState(tabId, { resultPanelCollapsed: nextCollapsed });
        requestAnimationFrame(() => {
            applyResultPanelLayout(nextCollapsed);
        });
    }, [
        applyResultPanelLayout,
        patchState,
        state.resultPanelCollapsed,
        tabId,
    ]);

    const handleResultPanelLayoutChanged = useCallback(
        (layout: Layout) => {
            const rawResultPanelSize = layout.resultPanel ?? 0;
            if (rawResultPanelSize <= 0) {
                if (!state.resultPanelCollapsed) {
                    patchState(tabId, { resultPanelCollapsed: true });
                }
                return;
            }

            const resultPanelSize =
                getSqlEditorResultPanelSize(rawResultPanelSize);
            if (
                state.resultPanelCollapsed ||
                state.resultPanelSize !== resultPanelSize
            ) {
                patchState(tabId, {
                    resultPanelCollapsed: false,
                    resultPanelSize,
                });
            }
        },
        [
            patchState,
            state.resultPanelCollapsed,
            state.resultPanelSize,
            tabId,
        ],
    );

    const databaseOptions = useMemo<SqlEditorContextOption[]>(
        () =>
            showDatabase
                ? (databaseQuery.data ?? [])
                      .filter(
                          (item) =>
                              item.kind === "database" && item.container.database,
                      )
                      .map((item) => ({
                          value: item.container.database ?? item.name,
                          label: item.name,
                          database: item.container.database ?? item.name,
                      }))
                : [],
        [databaseQuery.data, showDatabase],
    );

    const schemaOptions = useMemo<SqlEditorContextOption[]>(
        () =>
            showSchema
                ? (schemaContainers ?? [])
                      .filter(
                          (item) => item.kind === "schema" && item.container.schema,
                      )
                      .map((item) => ({
                          value: item.container.schema ?? item.name,
                          label: item.name,
                          database: item.container.database ?? null,
                      }))
                : [],
        [schemaContainers, showSchema],
    );
    const completionMetadata = useSqlCompletionMetadata({
        profileId,
        context: effectiveContext,
        showSchema,
        databaseContainers: databaseQuery.data,
        schemaContainers,
        sqlText: state.sqlText,
        cursorOffset: editorTargetState.cursorOffset,
    });
    const completionContext = useMemo<SqlCompletionBuildInput>(
        () => ({
            driverName: normalizedDriverName,
            showSchema,
            databases: databaseOptions.map((option) => option.value),
            schemas: schemaOptions.map((option) => option.value),
            objects: completionMetadata.objects,
            columns: completionMetadata.columns,
        }),
        [
            completionMetadata.columns,
            completionMetadata.objects,
            databaseOptions,
            normalizedDriverName,
            schemaOptions,
            showSchema,
        ],
    );

    useEffect(() => {
        completionContextRef.current = completionContext;
    }, [completionContext]);

    useEffect(() => {
        triggerSqlColumnSuggestIfNeeded({
            editor: sqlEditorRef.current,
            columnsAvailable: completionMetadata.columns.length > 0,
        });
    }, [completionMetadata.columns]);

    useEffect(() => {
        if (effectiveContext.database || !databaseOptions[0]) return;

        patchState(tabId, {
            context: {
                database: databaseOptions[0].value,
                schema: null,
            },
        });
    }, [databaseOptions, effectiveContext.database, patchState, tabId]);

    useEffect(() => {
        if (!showSchema || effectiveContext.schema || !schemaOptions[0]) {
            return;
        }

        if (contextMode.schemaParent === "database" && !effectiveContext.database) {
            return;
        }

        patchState(tabId, {
            context: {
                database:
                    schemaOptions[0].database ??
                    effectiveContext.database ??
                    null,
                schema: schemaOptions[0].value,
            },
        });
    }, [
        contextMode.schemaParent,
        effectiveContext.database,
        effectiveContext.schema,
        patchState,
        schemaOptions,
        showSchema,
        tabId,
    ]);

    const primaryRunHint = useMemo(
        () =>
            buildSqlPrimaryRunHint({
                fullText: state.sqlText,
                selectedText: editorTargetState.selectedText,
                isExecuting,
            }),
        [
            editorTargetState.selectedText,
            isExecuting,
            state.sqlText,
        ],
    );
    const currentStatementHint = useMemo(
        () =>
            buildSqlCurrentStatementHint({
                fullText: state.sqlText,
                cursorOffset: editorTargetState.cursorOffset,
                isExecuting,
            }),
        [editorTargetState.cursorOffset, isExecuting, state.sqlText],
    );
    const runAllHint = useMemo(
        () =>
            buildSqlScriptExecutionHint({
                sqlText: state.sqlText,
                source: "all",
                isExecuting: false,
                stopRequested: false,
            }),
        [state.sqlText],
    );
    const selectionRunHint = useMemo(
        () =>
            buildSqlPrimaryRunHint({
                fullText: "",
                selectedText: editorTargetState.selectedText,
                isExecuting: false,
            }),
        [editorTargetState.selectedText],
    );
    const scriptExecutionHint = useMemo(
        () =>
            buildSqlScriptExecutionHint({
                sqlText: scriptExecutionHintTarget?.sqlText ?? state.sqlText,
                source: scriptExecutionHintTarget?.source ?? "all",
                isExecuting: isScriptExecuting,
                stopRequested: state.scriptBatch?.stopRequested ?? false,
            }),
        [
            isScriptExecuting,
            scriptExecutionHintTarget?.source,
            scriptExecutionHintTarget?.sqlText,
            state.scriptBatch?.stopRequested,
            state.sqlText,
        ],
    );
    const visibleExecutionHint = isScriptExecuting
        ? scriptExecutionHint
        : primaryRunHint;
    const setScriptBatch = useCallback(
        (batch: SqlScriptExecutionBatch | null) => {
            scriptBatchRef.current = batch;
            patchState(tabId, { scriptBatch: batch });
        },
        [patchState, tabId],
    );

    const executeSqlPage = useCallback(
        (nextPage: number) => {
            const snapshot =
                useTabRuntimeStateStore.getState().sqlEditorByTabId[tabId]
                    ?.lastExecution;
            if (
                !snapshot ||
                snapshot.resultMode !== "grid" ||
                executionInFlightRef.current ||
                isExecuting ||
                isScriptExecuting
            ) {
                return;
            }

            executionInFlightRef.current = true;
            expandResultPanel();
            const page = Math.max(1, nextPage);
            patchState(tabId, {
                scriptBatch: null,
                page,
                pageSize: snapshot.pageSize,
                resultPanelCollapsed: false,
                lastExecution: {
                    sql: snapshot.sql,
                    context: snapshot.context,
                    page,
                    pageSize: snapshot.pageSize,
                    resultMode: "grid",
                },
            });
            const pageExecution = lifecycle.execute({
                sql: snapshot.sql,
                context: snapshot.context,
                page,
                pageSize: snapshot.pageSize,
                resultMode: "grid",
            });
            void pageExecution
                .catch((error: IAppError) => {
                    console.error("[sql-editor] page execution failed", {
                        profileId,
                        runtimeTabId: tabRuntimeId,
                        code: error.code,
                        message: error.message,
                    });
                })
                .finally(() => {
                    executionInFlightRef.current = false;
                });
        },
        [
            expandResultPanel,
            isExecuting,
            isScriptExecuting,
            lifecycle,
            patchState,
            profileId,
            tabId,
            tabRuntimeId,
        ],
    );

    const handlePreviousPage = useCallback(() => {
        const currentPage =
            useTabRuntimeStateStore.getState().sqlEditorByTabId[tabId]?.page ?? 1;
        executeSqlPage(currentPage - 1);
    }, [executeSqlPage, tabId]);

    const handleNextPage = useCallback(() => {
        const currentPage =
            useTabRuntimeStateStore.getState().sqlEditorByTabId[tabId]?.page ?? 1;
        executeSqlPage(currentPage + 1);
    }, [executeSqlPage, tabId]);

    const saveMutation = useMutation<SavedQuery, unknown, SaveQueryInput>({
        mutationFn: async (input) => {
            const context = normalizeContextForDriver(input.context, showSchema);

            if (savedQueryId) {
                return await updateSavedQuery({
                    id: savedQueryId,
                    title: input.title,
                    databaseName: context.database,
                    schemaName: context.schema,
                    sqlText: input.sqlText,
                    sortOrder: null,
                } satisfies UpdateSavedQueryInput);
            }

            return await createSavedQuery({
                id: nanoid(),
                profileId,
                title: input.title,
                driver: connection?.driver ?? (normalizedDriverName || "unknown"),
                databaseName: context.database,
                schemaName: context.schema,
                sqlText: input.sqlText,
                sortOrder: null,
            } satisfies CreateSavedQueryInput);
        },
        onSuccess: async (query, input) => {
            const persistedContext = normalizeContextForDriver(
                {
                    database: query.databaseName ?? null,
                    schema: query.schemaName ?? null,
                },
                showSchema,
            );
            const latestState =
                useTabRuntimeStateStore.getState().sqlEditorByTabId[tabId] ?? state;
            const savePatch = buildSqlEditorSaveSuccessPatch({
                currentSqlText: latestState.sqlText,
                currentContext: normalizeContextForDriver(
                    latestState.context,
                    showSchema,
                ),
                submittedSqlText: input.sqlText,
                submittedContext: normalizeContextForDriver(input.context, showSchema),
                persistedTitle: query.title,
                persistedSqlText: query.sqlText,
                persistedContext,
            });
            patchState(tabId, savePatch.patch);
            useWorkbenchTabsStore
                .getState()
                .retargetSqlEditorTabToSavedQuery(tabId, query.id, query.title, {
                    isDirty: !savePatch.shouldClearDirty,
                });
            await queryClient.invalidateQueries({
                queryKey: queryKeys.savedQueries(profileId),
            });
            toast.success("查询已保存");
        },
        onError: (error) => {
            console.error("[sql-editor] failed to save query", error);
            toast.error("保存查询失败");
        },
    });
    const { mutate: saveQuery, isPending: isSaving } = saveMutation;

    const executeSingleSqlTarget = useCallback(
        (sql: string, resultMode: SqlResultMode = "grid") => {
            if (
                executionInFlightRef.current ||
                isExecuting ||
                isScriptExecuting
            ) {
                return;
            }

            executionInFlightRef.current = true;
            expandResultPanel();
            patchState(tabId, {
                scriptBatch: null,
                page: 1,
                pageSize: state.pageSize,
                resultPanelCollapsed: false,
                lastExecution: {
                    sql,
                    context: effectiveContext,
                    page: 1,
                    pageSize: state.pageSize,
                    resultMode,
                },
            });
            const focusedExecution = lifecycle.execute({
                sql,
                context: effectiveContext,
                page: 1,
                pageSize: state.pageSize,
                resultMode,
            });
            void focusedExecution
                .catch((error: IAppError) => {
                    console.error("[sql-editor] focused execution failed", {
                        profileId,
                        runtimeTabId: tabRuntimeId,
                        code: error.code,
                        message: error.message,
                    });
                })
                .finally(() => {
                    executionInFlightRef.current = false;
                });
        },
        [
            effectiveContext,
            expandResultPanel,
            isExecuting,
            isScriptExecuting,
            lifecycle,
            patchState,
            profileId,
            state.pageSize,
            tabId,
            tabRuntimeId,
        ],
    );

    const handleStopScript = useCallback(() => {
        scriptStopRequestedRef.current = true;
        const currentBatch = scriptBatchRef.current;
        if (currentBatch) {
            setScriptBatch(requestSqlScriptQueueStop(currentBatch));
        }
        toast.info("已请求停止队列，当前 SQL 完成后不会继续执行后续语句");
    }, [setScriptBatch]);

    const handleCancelActive = useCallback(() => {
        const currentBatch = scriptBatchRef.current;
        if (currentBatch?.activeStatementId) {
            scriptStopRequestedRef.current = true;
            setScriptBatch(requestSqlScriptActiveCancel(currentBatch));
        }
        void lifecycle.cancelActive().catch((error: IAppError) => {
            console.error("[sql-editor] cancel active failed", {
                profileId,
                runtimeTabId: tabRuntimeId,
                code: error.code,
                message: error.message,
            });
        });
    }, [lifecycle, profileId, setScriptBatch, tabRuntimeId]);

    const handleTimeoutChange = useCallback(
        (timeoutMs: SqlExecutionTimeoutMs) => {
            patchState(tabId, (current) => ({
                executionOptions: {
                    ...current.executionOptions,
                    timeoutMs,
                },
            }));
        },
        [patchState, tabId],
    );

    const executeSqlScriptBatch = useCallback(async (params: {
        sqlText: string;
        source: SqlRunTargetSource;
    }) => {
        if (executionInFlightRef.current || isExecuting || isScriptExecuting) {
            return;
        }

        const initialBatch = createSqlScriptBatch({
            sqlText: params.sqlText,
            context: effectiveContext,
            pageSize: state.pageSize,
        });
        if (initialBatch.statements.length === 0) {
            toast.error("SQL 不能为空");
            return;
        }

        scriptStopRequestedRef.current = false;
        executionInFlightRef.current = true;
        setIsScriptExecuting(true);
        setScriptExecutionHintTarget({
            sqlText: params.sqlText,
            source: params.source,
        });
        expandResultPanel();
        patchState(tabId, {
            result: null,
            error: null,
            lastExecution: null,
            page: 1,
            resultPanelCollapsed: false,
            scriptBatch: initialBatch,
        });
        scriptBatchRef.current = initialBatch;

        let workingBatch = initialBatch;
        try {
            for (
                let statementIndex = 0;
                statementIndex < initialBatch.statements.length;
                statementIndex += 1
            ) {
                if (scriptStopRequestedRef.current) {
                    workingBatch = markSqlScriptRemainingSkipped(
                        workingBatch,
                        statementIndex - 1,
                    );
                    setScriptBatch(workingBatch);
                    break;
                }

                const statement = workingBatch.statements[statementIndex];
                if (!statement) continue;

                try {
                    const terminal = await lifecycle.execute({
                        sql: statement.sql,
                        context: initialBatch.context,
                        page: 1,
                        pageSize: initialBatch.pageSize,
                        resultMode: "grid",
                        onSnapshot: (snapshot) => {
                            workingBatch = applySqlScriptStatementSnapshot(
                                scriptBatchRef.current ?? workingBatch,
                                statement.id,
                                snapshot,
                            );
                            setScriptBatch(workingBatch);
                        },
                    });
                    workingBatch = applySqlScriptStatementSnapshot(
                        scriptBatchRef.current ?? workingBatch,
                        statement.id,
                        terminal,
                    );
                    setScriptBatch(workingBatch);

                    if (terminal.state !== "succeeded") {
                        workingBatch = markSqlScriptRemainingSkipped(
                            workingBatch,
                            statementIndex,
                        );
                        setScriptBatch(workingBatch);
                        break;
                    }
                } catch (error) {
                    workingBatch = markSqlScriptStatementStartFailed(
                        scriptBatchRef.current ?? workingBatch,
                        statement.id,
                        error as IAppError,
                    );
                    workingBatch = markSqlScriptRemainingSkipped(
                        workingBatch,
                        statementIndex,
                    );
                    setScriptBatch(workingBatch);
                    break;
                }
            }
        } finally {
            const latestBatch = scriptBatchRef.current ?? workingBatch;
            const finishedBatch = markSqlScriptBatchFinished(latestBatch);
            setScriptBatch(finishedBatch);
            scriptStopRequestedRef.current = false;
            executionInFlightRef.current = false;
            setIsScriptExecuting(false);
            setScriptExecutionHintTarget(null);
        }
    }, [
        effectiveContext,
        expandResultPanel,
        isExecuting,
        isScriptExecuting,
        lifecycle,
        patchState,
        setScriptBatch,
        state.pageSize,
        tabId,
    ]);

    const handleRun = useCallback(() => {
        if (executionInFlightRef.current || isExecuting || isScriptExecuting) {
            return;
        }

        const target = resolveSqlPrimaryRunTarget({
            fullText: state.sqlText,
            selectedText: editorSelectionRef.current,
        });
        if (!target.ok) {
            toast.error("SQL 不能为空");
            return;
        }

        if (target.kind === "single") {
            executeSingleSqlTarget(target.sql);
            return;
        }

        void executeSqlScriptBatch({
            sqlText: target.sqlText,
            source: target.source,
        });
    }, [
        executeSingleSqlTarget,
        executeSqlScriptBatch,
        isExecuting,
        isScriptExecuting,
        state.sqlText,
    ]);

    const handleRunRaw = useCallback(() => {
        if (executionInFlightRef.current || isExecuting || isScriptExecuting) {
            return;
        }

        const target = resolveSqlPrimaryRunTarget({
            fullText: state.sqlText,
            selectedText: editorSelectionRef.current,
        });
        if (!target.ok) {
            toast.error("SQL 不能为空");
            return;
        }
        if (target.kind !== "single") {
            toast.error("原始结果每次只允许执行一条 SQL");
            return;
        }
        executeSingleSqlTarget(target.sql, "raw");
    }, [
        executeSingleSqlTarget,
        isExecuting,
        isScriptExecuting,
        state.sqlText,
    ]);

    const handleRunScript = useCallback(() => {
        void executeSqlScriptBatch({
            sqlText: state.sqlText,
            source: "all",
        });
    }, [executeSqlScriptBatch, state.sqlText]);

    const handleRunSelection = useCallback(() => {
        const selectedText = editorSelectionRef.current.trim();
        if (!selectedText) {
            toast.error("请先选取要运行的 SQL");
            return;
        }

        const target = resolveSqlPrimaryRunTarget({
            fullText: "",
            selectedText,
        });
        if (!target.ok) {
            toast.error("SQL 不能为空");
            return;
        }

        if (target.kind === "single") {
            executeSingleSqlTarget(target.sql);
            return;
        }

        void executeSqlScriptBatch({
            sqlText: target.sqlText,
            source: "selection",
        });
    }, [executeSingleSqlTarget, executeSqlScriptBatch]);

    const handleRunCurrentStatement = useCallback(() => {
        if (executionInFlightRef.current || isExecuting || isScriptExecuting) {
            return;
        }

        const target = resolveSqlCurrentStatementTarget({
            fullText: state.sqlText,
            cursorOffset: editorCursorOffsetRef.current,
        });
        if (!target.ok) {
            toast.error(
                target.reason === "empty"
                    ? "SQL 不能为空"
                    : "光标不在可执行 SQL 语句内",
            );
            return;
        }

        executeSingleSqlTarget(target.sql);
    }, [
        executeSingleSqlTarget,
        isExecuting,
        isScriptExecuting,
        state.sqlText,
    ]);

    const handleSave = useCallback(() => {
        if (savedQueryId) {
            saveQuery({
                title,
                sqlText: state.sqlText,
                context: effectiveContext,
            });
            return;
        }
        patchState(tabId, { isSaveDialogOpen: true });
    }, [
        effectiveContext,
        patchState,
        saveQuery,
        savedQueryId,
        state.sqlText,
        tabId,
        title,
    ]);

    const handleNew = useCallback(() => {
        void openSqlEditorTab(profileId, {
            title: "未命名查询",
            context: effectiveContext,
        }).catch((error) => {
            console.error("[sql-editor] failed to open new query tab", error);
        });
    }, [effectiveContext, openSqlEditorTab, profileId]);

    const handleContextChange = useCallback(
        (context: SqlExecutionContext) => {
            patchState(tabId, {
                context: normalizeContextForDriver(context, showSchema),
            });
        },
        [patchState, showSchema, tabId],
    );

    const handleSelectScriptStatement = useCallback(
        (statementId: string) => {
            patchState(tabId, (current) => {
                if (!current.scriptBatch) return {};
                return {
                    scriptBatch: {
                        ...current.scriptBatch,
                        selectedStatementId: statementId,
                    },
                };
            });
        },
        [patchState, tabId],
    );

    const handleSaveRawArtifact = useCallback(
        async (
            input: RawSqlArtifactOwner & { format: string | null },
        ): Promise<void> => {
            if (isSavingRawArtifact) return;
            setIsSavingRawArtifact(true);
            try {
                const result = await saveRawSqlResult(
                    {
                        selectDestination: async (defaultPath) =>
                            await selectSaveDestination({ defaultPath }),
                        save: async (saveInput) =>
                            await saveSqlExecutionArtifact(
                                defaultSqlExecutionTransport,
                                saveInput,
                            ),
                    },
                    input,
                );
                if (result === "saved") {
                    toast.success("原始结果已另存");
                }
            } catch (error) {
                const normalized = normalizeIpcError(error);
                console.error("[sql-editor] Raw artifact save failed", {
                    profileId: input.profileId,
                    runtimeTabId: input.tabId,
                    executionId: input.executionId,
                    artifactId: input.artifactId,
                    code: normalized.code,
                });
                toast.error("原始结果另存失败，可重试");
            } finally {
                setIsSavingRawArtifact(false);
            }
        },
        [isSavingRawArtifact],
    );

    const handleEditorMount: CodeEditorOnMount = useCallback((editor, monaco) => {
        sqlEditorRef.current = editor;
        const updateEditorSelectionState = () => {
            const selection = editor.getSelection();
            const position = editor.getPosition();
            const model = editor.getModel();
            const selectedText =
                selection && model ? model.getValueInRange(selection) : "";
            const cursorOffset =
                position && model ? model.getOffsetAt(position) : 0;
            editorSelectionRef.current = selectedText;
            editorCursorOffsetRef.current = cursorOffset;
            setEditorTargetState({ selectedText, cursorOffset });
        };

        updateEditorSelectionState();
        const selectionDisposable =
            editor.onDidChangeCursorSelection(updateEditorSelectionState);
        const contentDisposable = editor.onDidChangeModelContent(
            updateEditorSelectionState,
        );
        const completionDisposable = registerSqlCompletionProvider({
            editor,
            monaco,
            getCompletionContext: () => completionContextRef.current,
        });
        editor.onDidDispose(() => {
            if (sqlEditorRef.current === editor) {
                sqlEditorRef.current = null;
            }
            selectionDisposable.dispose();
            contentDisposable.dispose();
            completionDisposable.dispose();
        });
    }, []);

    useEffect(() => {
        if (!isScriptExecuting) return;
        setExecuting(tabId, true);
        return () => setExecuting(tabId, false);
    }, [isScriptExecuting, setExecuting, tabId]);

    useEffect(() => {
        setDirty(tabId, isDirty);
    }, [isDirty, setDirty, tabId]);

    useSqlEditorToolbar({
        tabId,
        driverName:
            activeTab?.type === "sql_editor"
                ? activeTab.payload.runtime.driverName
                : (connection?.driver ?? ""),
        isExecuting,
        isSaving,
        canSave: state.sqlText.trim().length > 0,
        runTitle: primaryRunHint.runTitle,
        canRunScript: runAllHint.tone !== "idle",
        canRunSelection: selectionRunHint.tone !== "idle",
        canRunCurrentStatement: currentStatementHint.tone !== "idle",
        runScriptTitle: runAllHint.runTitle,
        runSelectionTitle:
            selectionRunHint.tone === "idle"
                ? "请先选取要运行的 SQL"
                : selectionRunHint.runTitle,
        runCurrentStatementTitle: currentStatementHint.runTitle,
        isScriptExecuting,
        canStopScript: isScriptExecuting && !state.scriptBatch?.stopRequested,
        managedLifecycle:
            sqlExecutionFeatures?.managedLifecycle === true,
        activeCancel: sqlExecutionFeatures?.activeCancel === true,
        rawResult: sqlExecutionFeatures?.rawResult === true,
        configurableTimeout:
            sqlExecutionFeatures?.configurableTimeout === true,
        timeoutMs: state.executionOptions.timeoutMs,
        executionState: state.activeExecution?.state ?? null,
        resultPanelCollapsed: state.resultPanelCollapsed,
        onRun: handleRun,
        onRunScript: handleRunScript,
        onRunSelection: handleRunSelection,
        onRunCurrentStatement: handleRunCurrentStatement,
        onStopScript: handleStopScript,
        onCancelActive: handleCancelActive,
        onRunRaw: handleRunRaw,
        onTimeoutChange: handleTimeoutChange,
        onSave: handleSave,
        onNew: handleNew,
        onToggleResultPanel: handleToggleResultPanel,
        onOpenSessionViews: () =>
            void openClickHouseTemporaryViewTab(profileId, tabRuntimeId),
    });

    useEffect(() => {
        applyResultPanelLayout(
            state.resultPanelCollapsed,
            state.resultPanelSize,
        );
    }, [
        applyResultPanelLayout,
        state.resultPanelCollapsed,
        state.resultPanelSize,
    ]);

    const defaultSaveTitle =
        state.savedSnapshot?.title ?? (title === "未命名查询" ? "" : title);

    return (
        <>
            <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
                <SqlEditorContextBar
                    connectionName={connection?.name ?? profileId}
                    context={effectiveContext}
                    databaseOptions={databaseOptions}
                    schemaOptions={schemaOptions}
                    showDatabase={showDatabase}
                    showSchema={showSchema}
                    disabled={isExecuting || isScriptExecuting}
                    rightSlot={
                        <SqlExecutionTargetHint hint={visibleExecutionHint} />
                    }
                    onContextChange={handleContextChange}
                />
                <ResizablePanelGroup
                    id={`sqlEditorResultLayout-${tabId}`}
                    className="min-h-0 flex-1"
                    orientation="vertical"
                    groupRef={resultPanelGroupRef}
                    onLayoutChanged={handleResultPanelLayoutChanged}
                >
                    <ResizablePanel
                        id="editorPanel"
                        defaultSize={
                            state.resultPanelCollapsed
                                ? "100%"
                                : `${100 - state.resultPanelSize}%`
                        }
                        minSize="180px"
                        groupResizeBehavior="preserve-pixel-size"
                    >
                        <div className="h-full min-h-0 overflow-hidden">
                            {isActive ? (
                                <CodeEditor
                                    value={state.sqlText}
                                    language="sql"
                                    preset="sqlEditor"
                                    height="100%"
                                    heightMode="fixed"
                                    className="h-full rounded-none border-0"
                                    onChange={(sqlText) =>
                                        patchState(tabId, { sqlText })
                                    }
                                    onMount={handleEditorMount}
                                />
                            ) : (
                                <div className="h-full bg-background" />
                            )}
                        </div>
                    </ResizablePanel>

                    <ResizableHandle withHandle />

                    <ResizablePanel
                        id="resultPanel"
                        defaultSize={
                            state.resultPanelCollapsed
                                ? "0%"
                                : `${state.resultPanelSize}%`
                        }
                        minSize="160px"
                        collapsible
                        groupResizeBehavior="preserve-pixel-size"
                    >
                        <div className="h-full min-h-0 border-t">
                            <SqlEditorResultPanel
                                result={state.result}
                                outcome={state.lastOutcome}
                                error={state.error}
                                isExecuting={isExecuting}
                                page={state.page}
                                pageSize={state.pageSize}
                                scriptBatch={state.scriptBatch}
                                onPreviousPage={handlePreviousPage}
                                onNextPage={handleNextPage}
                                onSelectScriptStatement={
                                    handleSelectScriptStatement
                                }
                                rawArtifactOwner={
                                    state.activeExecution
                                        ? {
                                              profileId,
                                              tabId: tabRuntimeId,
                                              executionId:
                                                  state.activeExecution
                                                      .executionId,
                                          }
                                        : null
                                }
                                isSavingRawArtifact={isSavingRawArtifact}
                                onSaveRawArtifact={handleSaveRawArtifact}
                            />
                        </div>
                    </ResizablePanel>
                </ResizablePanelGroup>
            </div>
            <SaveQueryDialog
                open={state.isSaveDialogOpen}
                defaultTitle={defaultSaveTitle}
                isSaving={isSaving}
                onOpenChange={(open) => patchState(tabId, { isSaveDialogOpen: open })}
                onSave={(nextTitle) =>
                    saveQuery({
                        title: nextTitle,
                        sqlText: state.sqlText,
                        context: effectiveContext,
                    })
                }
            />
            {state.activeExecution ? (
                <ExecutionDetailDrawer
                    open={isActive && state.executionDetailOpen}
                    onOpenChange={(open) =>
                        patchState(tabId, { executionDetailOpen: open })
                    }
                    context={{
                        uiTabId: tabId,
                        profileId,
                        driverName:
                            normalizedDriverName ||
                            connection?.driver ||
                            "unknown",
                        features: sqlExecutionFeatures,
                        snapshot: state.activeExecution,
                    }}
                    timeline={state.executionTimeline}
                    options={{
                        ...state.executionOptions,
                        resultMode:
                            state.lastExecution?.resultMode ??
                            state.executionOptions.resultMode,
                    }}
                />
            ) : null}
        </>
    );
}
