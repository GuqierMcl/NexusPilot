import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type FC,
} from "react";
import {
    FileCode2,
    RefreshCw,
    Save,
    TableProperties,
    TriangleAlert,
    Undo2,
} from "lucide-react";
import { toast } from "@/components/ui/toast";

import {
    Alert,
    AlertDescription,
    AlertTitle,
} from "@/components/ui/alert";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    joinSchemaDdlStatements,
    SchemaDdlPreviewDrawer,
} from "@/features/workbench/content/components/schema-design/schema-ddl-preview-drawer";
import { supportsSchemaMutation } from "@/lib/schema-mutation-capabilities";
import {
    useConnectionSessionStore,
    useContentToolbarStore,
    useTabRuntimeStateStore,
    useWorkbenchTabsStore,
} from "@/store";
import type {
    ClickHouseColumnActionDraft,
    ClickHouseTableEditDraft,
    ClickHouseTableObjectActionDraft,
} from "@/types/clickhouse-table-design";
import type { ClickHouseTableSchema, ContainerRef } from "@/types/ipc";

import { ClickHouseSchemaHeader } from "./ClickHouseSchemaHeader";
import { buildClickHouseTableDesignViewModel } from "./clickhouse-table-design-view-model";
import {
    clickHouseEditDraftTargetKey,
    clickHouseSchemaToEditDraft,
    cloneClickHouseTableEditDraft,
} from "./clickhouse-table-edit-draft";
import { canRequestClickHouseEditPreview } from "./clickhouse-table-edit-lifecycle";
import { validateClickHouseTableEditDraft } from "./clickhouse-table-edit-validation";
import { ClickHouseColumnsEdit } from "./tabs/clickhouse-columns-edit";
import { ClickHouseEngineKeysEdit } from "./tabs/clickhouse-engine-keys-edit";
import { ClickHouseProjectionsEdit } from "./tabs/clickhouse-projections-edit";
import { ClickHouseSkippingIndexesEdit } from "./tabs/clickhouse-skipping-indexes-edit";
import { ClickHouseTtlSettingsEdit } from "./tabs/clickhouse-ttl-settings-edit";
import { useClickHouseTableEditPreview } from "./use-clickhouse-table-edit-preview";
import { useClickHouseTableEditSave } from "./use-clickhouse-table-edit-save";
import { useClickHouseTableObjectChange } from "./use-clickhouse-table-object-change";

interface ClickHouseTableEditViewProps {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    container: ContainerRef;
    schema: ClickHouseTableSchema;
    isActive: boolean;
    onRefresh: () => Promise<ClickHouseTableSchema | undefined>;
}

type EditConfirmation =
    | { kind: "alter" }
    | { kind: "columnAction"; action: ClickHouseColumnActionDraft }
    | { kind: "tableObject"; action: ClickHouseTableObjectActionDraft }
    | { kind: "refresh" }
    | { kind: "reset" }
    | null;

function safeDownloadName(tableName: string): string {
    const safeName = tableName.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_");
    return safeName || "clickhouse-table-alter";
}

export const ClickHouseTableEditView: FC<ClickHouseTableEditViewProps> = ({
    tabId,
    profileId,
    tabRuntimeId,
    container,
    schema,
    isActive,
    onRefresh,
}) => {
    const initialDraft = useMemo(
        () => clickHouseSchemaToEditDraft(schema),
        [schema],
    );
    const fallbackState = useMemo(
        () => ({
            mode: "edit" as const,
            draft: initialDraft,
            snapshot: cloneClickHouseTableEditDraft(initialDraft),
            conflictRemoteSchema: null,
            pendingColumnAction: null,
            pendingObjectAction: null,
        }),
        [initialDraft],
    );
    const storedDesignState = useTabRuntimeStateStore(
        (state) => state.clickHouseTableDesignByTabId[tabId],
    );
    const designState =
        storedDesignState?.mode === "edit"
            ? storedDesignState
            : fallbackState;
    const operationState = useTabRuntimeStateStore(
        (state) =>
            state.schemaDesignByTabId[tabId]?.operationState ?? "idle",
    );
    const getOrCreateClickHouseTableDesignState = useTabRuntimeStateStore(
        (state) => state.getOrCreateClickHouseTableDesignState,
    );
    const patchClickHouseTableDesignState = useTabRuntimeStateStore(
        (state) => state.patchClickHouseTableDesignState,
    );
    const resetClickHouseTableDesignDraft = useTabRuntimeStateStore(
        (state) => state.resetClickHouseTableDesignDraft,
    );
    const removeClickHouseTableDesignState = useTabRuntimeStateStore(
        (state) => state.removeClickHouseTableDesignState,
    );
    const patchSchemaDesignState = useTabRuntimeStateStore(
        (state) => state.patchSchemaDesignState,
    );
    const setDirty = useWorkbenchTabsStore((state) => state.setDirty);
    const setExecuting = useWorkbenchTabsStore((state) => state.setExecuting);
    const setToolbar = useContentToolbarStore((state) => state.setToolbar);
    const clearToolbar = useContentToolbarStore((state) => state.clearToolbar);
    const capabilities = useConnectionSessionStore(
        (state) => state.sessions[profileId]?.capabilities,
    );
    const canClearColumn = supportsSchemaMutation(
        capabilities,
        "column",
        "clear",
    );
    const canMaterializeColumn = supportsSchemaMutation(
        capabilities,
        "column",
        "materialize",
    );
    const canCreateProjection = supportsSchemaMutation(
        capabilities,
        "projection", "create",
    );
    const canDropProjection = supportsSchemaMutation(
        capabilities,
        "projection", "drop",
    );
    const canClearProjection = supportsSchemaMutation(
        capabilities,
        "projection", "clear",
    );
    const canMaterializeProjection = supportsSchemaMutation(
        capabilities,
        "projection", "materialize",
    );
    const canCreateIndex = supportsSchemaMutation(
        capabilities,
        "index", "create",
    );
    const canDropIndex = supportsSchemaMutation(
        capabilities,
        "index", "drop",
    );
    const canClearIndex = supportsSchemaMutation(
        capabilities,
        "index", "clear",
    );
    const canMaterializeIndex = supportsSchemaMutation(
        capabilities,
        "index", "materialize",
    );
    const [confirmation, setConfirmation] =
        useState<EditConfirmation>(null);
    const [isDdlDrawerOpen, setIsDdlDrawerOpen] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const drawerContainerRef = useRef<HTMLDivElement>(null);
    const draft = designState.draft;
    const snapshot = designState.snapshot;
    const issues = useMemo(
        () => validateClickHouseTableEditDraft(draft),
        [draft],
    );
    const isDirty = useMemo(
        () =>
            clickHouseEditDraftTargetKey(draft) !==
            clickHouseEditDraftTargetKey(snapshot),
        [draft, snapshot],
    );
    const hasConflict = designState.conflictRemoteSchema != null;
    const hasTableObjectDependencies =
        draft.baseline.projections.length > 0 ||
        draft.baseline.skippingIndexes.length > 0;
    const hasPendingObjectAction = designState.pendingObjectAction != null;
    const requiresRemoteResolution = [
        "submitted",
        "partiallyApplied",
        "outcomeUnknown",
        "conflict",
    ].includes(operationState);
    const model = useMemo(
        () => buildClickHouseTableDesignViewModel(schema),
        [schema],
    );
    const canRequestPreview = canRequestClickHouseEditPreview({
        enabled: isActive,
        isDirty,
        hasConflict,
        operationState,
    });
    const previewState = useClickHouseTableEditPreview({
        profileId,
        tabId,
        draft,
        issues,
        hasConflict,
        enabled: canRequestPreview,
    });
    const objectChange = useClickHouseTableObjectChange({
        tabId,
        profileId,
        tabRuntimeId,
        container,
        baseline: draft.baseline,
        action: designState.pendingObjectAction,
        mainDraftDirty: isDirty,
        operationState,
    });
    const saveState = useClickHouseTableEditSave({
        tabId,
        profileId,
        tabRuntimeId,
        container,
        target: previewState.target,
        targetKey: previewState.targetKey,
        preview: previewState.preview,
        previewTargetKey: previewState.previewTargetKey,
        issues,
        isPreviewPending: previewState.isPending,
        previewErrorMessage: previewState.errorMessage,
    });
    const mainStructureDisabled =
        saveState.isApplying ||
        objectChange.isApplying ||
        hasConflict ||
        requiresRemoteResolution ||
        hasTableObjectDependencies ||
        hasPendingObjectAction;
    const objectActionsDisabled =
        isDirty ||
        saveState.isApplying ||
        objectChange.isApplying ||
        hasConflict ||
        requiresRemoteResolution ||
        isRefreshing;
    const activePreview = hasPendingObjectAction
        ? objectChange.preview
        : previewState.preview;
    const activePreviewError = hasPendingObjectAction
        ? objectChange.previewError
        : previewState.errorMessage;
    const activePreviewIssues = hasPendingObjectAction
        ? objectChange.issues
        : issues;
    const activePreviewPending = hasPendingObjectAction
        ? objectChange.isPreviewing
        : previewState.isPending;
    const ddlText = useMemo(
        () =>
            joinSchemaDdlStatements(activePreview?.statements ?? []),
        [activePreview?.statements],
    );

    useEffect(() => {
        const existing =
            useTabRuntimeStateStore.getState()
                .clickHouseTableDesignByTabId[tabId];
        if (existing && existing.mode !== "edit") {
            removeClickHouseTableDesignState(tabId);
        }
        getOrCreateClickHouseTableDesignState(tabId, {
            mode: "edit",
            draft: initialDraft,
        });
        return () => setExecuting(tabId, false);
    }, [
        getOrCreateClickHouseTableDesignState,
        initialDraft,
        removeClickHouseTableDesignState,
        setExecuting,
        tabId,
    ]);

    useEffect(() => {
        const current =
            useTabRuntimeStateStore.getState()
                .clickHouseTableDesignByTabId[tabId];
        const runtime =
            useTabRuntimeStateStore.getState().schemaDesignByTabId[tabId];
        if (
            current?.mode === "edit" &&
            current.draft.baseline.baseline.revisionHash !==
                schema.baseline.revisionHash &&
            !runtime?.isDirty &&
            current.conflictRemoteSchema == null
        ) {
            const next = clickHouseSchemaToEditDraft(schema);
            patchClickHouseTableDesignState(tabId, {
                mode: "edit",
                draft: next,
                snapshot: cloneClickHouseTableEditDraft(next),
                conflictRemoteSchema: null,
                pendingColumnAction: null,
                pendingObjectAction: null,
            });
        }
    }, [patchClickHouseTableDesignState, schema, tabId]);

    useEffect(() => {
        const blockerCount = issues.filter(
            (issue) => issue.path !== "table",
        ).length;
        setDirty(tabId, isDirty);
        patchSchemaDesignState(tabId, {
            mode: "edit",
            loadState: "ready",
            blockerCount,
            isDirty,
        });
    }, [
        isDirty,
        issues,
        patchSchemaDesignState,
        setDirty,
        tabId,
    ]);

    useEffect(() => {
        setExecuting(
            tabId,
            previewState.isPending ||
                saveState.isApplying ||
                objectChange.isPreviewing ||
                objectChange.isApplying ||
                isRefreshing,
        );
    }, [
        isRefreshing,
        previewState.isPending,
        saveState.isApplying,
        objectChange.isApplying,
        objectChange.isPreviewing,
        setExecuting,
        tabId,
    ]);

    const handleDraftChange = useCallback(
        (nextDraft: ClickHouseTableEditDraft) => {
            patchClickHouseTableDesignState(tabId, {
                mode: "edit",
                draft: nextDraft,
                conflictRemoteSchema: null,
            });
        },
        [patchClickHouseTableDesignState, tabId],
    );

    const adoptRemoteSchema = useCallback(
        (remote: ClickHouseTableSchema) => {
            const next = clickHouseSchemaToEditDraft(remote);
            patchClickHouseTableDesignState(tabId, {
                mode: "edit",
                draft: next,
                snapshot: cloneClickHouseTableEditDraft(next),
                conflictRemoteSchema: null,
                pendingColumnAction: null,
                pendingObjectAction: null,
            });
            patchSchemaDesignState(tabId, {
                operationState: "idle",
                blockerCount: 0,
                errorMessage: null,
                isDirty: false,
            });
            setDirty(tabId, false);
        },
        [
            patchClickHouseTableDesignState,
            patchSchemaDesignState,
            setDirty,
            tabId,
        ],
    );

    const refreshAndAdopt = useCallback(async () => {
        setIsRefreshing(true);
        try {
            const remote = await onRefresh();
            if (remote) adoptRemoteSchema(remote);
        } finally {
            setIsRefreshing(false);
        }
    }, [adoptRemoteSchema, onRefresh]);

    const handleRefresh = useCallback(() => {
        if (isDirty || hasConflict || operationState !== "idle") {
            setConfirmation({ kind: "refresh" });
            return;
        }
        void refreshAndAdopt();
    }, [
        hasConflict,
        isDirty,
        operationState,
        refreshAndAdopt,
    ]);

    const handleReset = useCallback(() => {
        resetClickHouseTableDesignDraft(tabId);
        patchSchemaDesignState(tabId, {
            operationState: "idle",
            errorMessage: null,
            isDirty: false,
        });
        setDirty(tabId, false);
    }, [
        patchSchemaDesignState,
        resetClickHouseTableDesignDraft,
        setDirty,
        tabId,
    ]);

    const handleSave = useCallback(() => {
        if (hasPendingObjectAction) {
            if (!objectChange.canExecute) return;
            if (objectChange.requiresConfirmation) {
                setConfirmation({
                    kind: "tableObject",
                    action: designState.pendingObjectAction!,
                });
                return;
            }
            setIsDdlDrawerOpen(false);
            void objectChange.execute(false);
            return;
        }
        if (!saveState.canSave) return;
        if (saveState.requiresDestructiveConfirmation) {
            setConfirmation({ kind: "alter" });
            return;
        }
        void saveState.executeAlter(false);
    }, [
        designState.pendingObjectAction,
        hasPendingObjectAction,
        objectChange,
        saveState,
    ]);

    const handleColumnAction = useCallback(
        (action: ClickHouseColumnActionDraft) => {
            patchClickHouseTableDesignState(tabId, {
                mode: "edit",
                pendingColumnAction: action,
            });
            setConfirmation({ kind: "columnAction", action });
        },
        [patchClickHouseTableDesignState, tabId],
    );

    const handleTableObjectAction = useCallback(
        (action: ClickHouseTableObjectActionDraft) => {
            patchClickHouseTableDesignState(tabId, {
                mode: "edit",
                pendingColumnAction: null,
                pendingObjectAction: action,
            });
            setIsDdlDrawerOpen(true);
        },
        [patchClickHouseTableDesignState, tabId],
    );

    const handleConfirm = useCallback(async () => {
        const pending = confirmation;
        setConfirmation(null);
        if (!pending) return;
        switch (pending.kind) {
            case "alter":
                await saveState.executeAlter(true);
                break;
            case "columnAction":
                await saveState.executeColumnAction(pending.action);
                break;
            case "tableObject":
                setIsDdlDrawerOpen(false);
                await objectChange.execute(true);
                break;
            case "refresh":
                await refreshAndAdopt();
                break;
            case "reset":
                handleReset();
                break;
        }
    }, [confirmation, handleReset, objectChange, refreshAndAdopt, saveState]);

    const handleConfirmationChange = useCallback(
        (open: boolean) => {
            if (open) return;
            if (confirmation?.kind === "columnAction") {
                patchClickHouseTableDesignState(tabId, {
                    mode: "edit",
                    pendingColumnAction: null,
                });
            }
            setConfirmation(null);
        },
        [confirmation, patchClickHouseTableDesignState, tabId],
    );

    const handleCopyDdl = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(ddlText);
            toast.success("DDL 已复制");
        } catch (error) {
            console.error("Failed to copy ClickHouse ALTER DDL", error);
            toast.error("复制 DDL 失败");
        }
    }, [ddlText]);

    const handleExportDdl = useCallback(() => {
        const blob = new Blob([ddlText], { type: "text/sql;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${safeDownloadName(schema.identity.name)}-alter.sql`;
        anchor.click();
        URL.revokeObjectURL(url);
    }, [ddlText, schema.identity.name]);

    const handleResetOrClear = useCallback(() => {
        if (hasPendingObjectAction) {
            objectChange.clear();
            setIsDdlDrawerOpen(false);
            return;
        }
        setConfirmation({ kind: "reset" });
    }, [hasPendingObjectAction, objectChange]);

    useEffect(() => {
        setToolbar(tabId, {
            actions: [
                {
                    id: "save",
                    icon: Save,
                    label: hasPendingObjectAction
                        ? "执行对象变更"
                        : "保存变更",
                    title: hasPendingObjectAction
                        ? "执行与当前对象及远端基线匹配的 DDL 计划"
                        : "执行与当前草稿及远端基线匹配的 ALTER 计划",
                    variant: "default",
                    disabled: hasPendingObjectAction
                        ? !objectChange.canExecute
                        : !saveState.canSave,
                    onClick: handleSave,
                },
                {
                    id: "previewDdl",
                    icon: FileCode2,
                    label: "DDL 预览",
                    title: hasPendingObjectAction
                        ? "查看当前 ClickHouse 对象 DDL 计划"
                        : "查看当前 ClickHouse ALTER 计划",
                    disabled: !isDirty && !hasPendingObjectAction,
                    onClick: () => setIsDdlDrawerOpen(true),
                },
                {
                    id: "refresh",
                    icon: RefreshCw,
                    label: "刷新结构",
                    title: "重新读取远端结构；有本地草稿时需要确认",
                    disabled:
                        isRefreshing ||
                        saveState.isApplying ||
                        objectChange.isApplying,
                    onClick: handleRefresh,
                },
                {
                    id: "resetDesign",
                    icon: Undo2,
                    label: hasPendingObjectAction ? "取消对象动作" : "重置草稿",
                    title: hasPendingObjectAction
                        ? "取消当前待执行对象动作"
                        : "恢复标签页保存的结构快照",
                    disabled:
                        (!isDirty && !hasConflict && !hasPendingObjectAction) ||
                        saveState.isApplying ||
                        objectChange.isApplying,
                    onClick: handleResetOrClear,
                },
            ],
            context: {
                icon: TableProperties,
                label: `${schema.identity.database}.${schema.identity.name}`,
            },
        });
        return () => clearToolbar(tabId);
    }, [
        clearToolbar,
        handleRefresh,
        handleResetOrClear,
        handleSave,
        hasConflict,
        hasPendingObjectAction,
        isDirty,
        isRefreshing,
        objectChange.canExecute,
        objectChange.isApplying,
        saveState.canSave,
        saveState.isApplying,
        schema.identity.database,
        schema.identity.name,
        setToolbar,
        tabId,
    ]);

    const confirmationTitle =
        confirmation?.kind === "alter"
            ? "确认执行破坏性结构变更？"
            : confirmation?.kind === "columnAction"
              ? `确认 ${confirmation.action.action.toUpperCase()} 整列数据？`
              : confirmation?.kind === "tableObject"
                ? `确认 ${confirmation.action.operation.toUpperCase()} ${confirmation.action.objectKind}？`
              : confirmation?.kind === "refresh"
                ? "采用最新远端结构？"
                : "重置本地结构草稿？";
    const confirmationDescription =
        confirmation?.kind === "alter"
            ? `将对 ${schema.identity.database}.${schema.identity.name} 执行 ${previewState.preview?.operations.length ?? 0} 项变更。后端会重新规划并核对完整远端基线。`
            : confirmation?.kind === "columnAction"
              ? `${schema.identity.database}.${schema.identity.name}.${confirmation.action.columnName} 将在整张表范围执行 ${confirmation.action.action.toUpperCase()}。该动作可能重写或清除数据。`
              : confirmation?.kind === "tableObject"
                ? `${schema.identity.database}.${schema.identity.name}.${confirmation.action.name} 将在整张表范围执行 ${confirmation.action.operation.toUpperCase()}。后端会重新规划、核对完整远端基线，并以可能耗时的破坏性动作提交。`
              : confirmation?.kind === "refresh"
                ? "最新远端结构会替换当前草稿与快照；本地未提交变更和冲突上下文将被清除。"
                : "当前未提交的结构草稿会恢复到标签页快照，远端结构不会被修改。";

    return (
        <>
            <div
                ref={drawerContainerRef}
                className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
                <ClickHouseSchemaHeader
                    model={model}
                    surfaceMode="edit"
                    isRefreshing={isRefreshing}
                    onRefresh={handleRefresh}
                />
                {(hasConflict ||
                    operationState === "partiallyApplied" ||
                    operationState === "outcomeUnknown" ||
                    operationState === "submitted") && (
                    <div className="shrink-0 px-3 py-2">
                        <Alert>
                            <TriangleAlert />
                            <AlertTitle>需要核对远端结构</AlertTitle>
                            <AlertDescription>
                                当前本地草稿未被远端结果覆盖。请使用“刷新结构”并明确确认是否采用最新远端事实。
                            </AlertDescription>
                        </Alert>
                    </div>
                )}
                <Tabs
                    defaultValue="columns"
                    className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
                >
                    <div className="min-w-0 shrink-0 overflow-x-auto border-b px-3 py-1">
                        <TabsList className="h-7 min-w-max" variant="line">
                            <TabsTrigger value="columns" className="text-xs">
                                Columns
                                <span className="text-muted-foreground">
                                    {draft.table.columns.length}
                                </span>
                            </TabsTrigger>
                            <TabsTrigger value="engine_keys" className="text-xs">
                                Engine & Keys
                            </TabsTrigger>
                            <TabsTrigger value="ttl_settings" className="text-xs">
                                TTL & Settings
                                <span className="text-muted-foreground">
                                    {draft.table.settings.length}
                                </span>
                            </TabsTrigger>
                            <TabsTrigger value="projections" className="text-xs">
                                Projections
                                <span className="text-muted-foreground">
                                    {model.projections.length}
                                </span>
                            </TabsTrigger>
                            <TabsTrigger
                                value="skipping_indexes"
                                className="text-xs"
                            >
                                Skipping Indexes
                                <span className="text-muted-foreground">
                                    {model.skippingIndexes.length}
                                </span>
                            </TabsTrigger>
                        </TabsList>
                    </div>
                    <TabsContent value="columns" className="min-h-0 flex-1 p-0">
                        <ScrollArea className="h-full">
                            <div className="p-3">
                                <ClickHouseColumnsEdit
                                    draft={draft}
                                    issues={issues}
                                    disabled={mainStructureDisabled}
                                    canClearColumn={canClearColumn}
                                    canMaterializeColumn={canMaterializeColumn}
                                    onChange={handleDraftChange}
                                    onColumnAction={handleColumnAction}
                                />
                            </div>
                        </ScrollArea>
                    </TabsContent>
                    <TabsContent
                        value="engine_keys"
                        className="min-h-0 flex-1 p-0"
                    >
                        <ScrollArea className="h-full">
                            <div className="p-3">
                                <ClickHouseEngineKeysEdit
                                    draft={draft}
                                    issues={issues}
                                    disabled={mainStructureDisabled}
                                    onChange={handleDraftChange}
                                />
                            </div>
                        </ScrollArea>
                    </TabsContent>
                    <TabsContent
                        value="ttl_settings"
                        className="min-h-0 flex-1 p-0"
                    >
                        <ScrollArea className="h-full">
                            <div className="p-3">
                                <ClickHouseTtlSettingsEdit
                                    draft={draft}
                                    issues={issues}
                                    disabled={mainStructureDisabled}
                                    onChange={handleDraftChange}
                                />
                            </div>
                        </ScrollArea>
                    </TabsContent>
                    <TabsContent
                        value="projections"
                        className="min-h-0 flex-1 p-0"
                    >
                        <ScrollArea className="h-full">
                            <div className="p-3">
                                <ClickHouseProjectionsEdit
                                    projections={draft.baseline.projections}
                                    disabled={objectActionsDisabled}
                                    canCreate={canCreateProjection}
                                    canDrop={canDropProjection}
                                    canClear={canClearProjection}
                                    canMaterialize={canMaterializeProjection}
                                    onRequestAction={handleTableObjectAction}
                                />
                            </div>
                        </ScrollArea>
                    </TabsContent>
                    <TabsContent
                        value="skipping_indexes"
                        className="min-h-0 flex-1 p-0"
                    >
                        <ScrollArea className="h-full">
                            <div className="p-3">
                                <ClickHouseSkippingIndexesEdit
                                    indexes={draft.baseline.skippingIndexes}
                                    disabled={objectActionsDisabled}
                                    canCreate={canCreateIndex}
                                    canDrop={canDropIndex}
                                    canClear={canClearIndex}
                                    canMaterialize={canMaterializeIndex}
                                    onRequestAction={handleTableObjectAction}
                                />
                            </div>
                        </ScrollArea>
                    </TabsContent>
                </Tabs>
                <SchemaDdlPreviewDrawer
                    isOpen={isDdlDrawerOpen}
                    onOpenChange={setIsDdlDrawerOpen}
                    containerRef={drawerContainerRef.current}
                    title={
                        hasPendingObjectAction
                            ? "ClickHouse 对象 DDL 预览"
                            : "ClickHouse ALTER DDL 预览"
                    }
                    description={`目标 ${schema.identity.database}.${schema.identity.name}；SQL 由后端强类型 planner 生成，不可编辑。`}
                    statements={activePreview?.statements ?? []}
                    warnings={activePreview?.warnings ?? []}
                    validationMessages={activePreviewIssues.map(
                        (issue) => issue.message,
                    )}
                    operations={activePreview?.operations ?? []}
                    destructive={activePreview?.destructive ?? false}
                    longRunning={activePreview?.longRunning ?? false}
                    isPending={activePreviewPending}
                    errorMessage={activePreviewError}
                    onCopy={() => void handleCopyDdl()}
                    onExport={handleExportDdl}
                />
            </div>
            <AlertDialog
                open={confirmation != null}
                onOpenChange={handleConfirmationChange}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{confirmationTitle}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirmationDescription}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction
                            variant={
                                confirmation?.kind === "alter" ||
                                confirmation?.kind === "columnAction" ||
                                confirmation?.kind === "tableObject"
                                    ? "destructive"
                                    : "default"
                            }
                            onClick={() => void handleConfirm()}
                        >
                            确认
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
};
