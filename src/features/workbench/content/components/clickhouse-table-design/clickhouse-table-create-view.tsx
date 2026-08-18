import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type FC,
} from "react";
import { FileCode2, Save, TableProperties, Undo2 } from "lucide-react";
import { toast } from "@/components/ui/toast";

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
import {
    useContentToolbarStore,
    useTabRuntimeStateStore,
    useWorkbenchTabsStore,
} from "@/store";
import type { ClickHouseTableCreateDraft } from "@/types/clickhouse-table-design";
import type { ContainerRef } from "@/types/ipc";

import {
    clickHouseDraftToCreateTarget,
    cloneClickHouseTableCreateDraft,
    createClickHouseTableDraft,
} from "./clickhouse-table-create-draft";
import { ClickHouseTableCreateHeader } from "./clickhouse-table-create-header";
import {
    clickHouseCreateTargetKey,
    validateClickHouseTableCreateDraft,
} from "./clickhouse-table-create-validation";
import { ClickHouseColumnsCreate } from "./tabs/clickhouse-columns-create";
import { ClickHouseEngineKeysCreate } from "./tabs/clickhouse-engine-keys-create";
import { ClickHouseTtlSettingsCreate } from "./tabs/clickhouse-ttl-settings-create";
import { useClickHouseTableCreatePreview } from "./use-clickhouse-table-create-preview";
import { useClickHouseTableCreateSave } from "./use-clickhouse-table-create-save";

interface ClickHouseTableCreateViewProps {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    parentContainer: ContainerRef;
    isActive: boolean;
}

function draftIdentityKey(draft: ClickHouseTableCreateDraft): string {
    return clickHouseCreateTargetKey(clickHouseDraftToCreateTarget(draft));
}

function safeDownloadName(tableName: string): string {
    const safeName = tableName
        .trim()
        .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_");
    return safeName || "clickhouse-table";
}

export const ClickHouseTableCreateView: FC<ClickHouseTableCreateViewProps> = ({
    tabId,
    profileId,
    tabRuntimeId,
    parentContainer,
    isActive,
}) => {
    const [initialDraft] = useState(() =>
        createClickHouseTableDraft(parentContainer.database ?? ""),
    );
    const fallbackState = useMemo(
        () => ({
            mode: "create" as const,
            draft: initialDraft,
            snapshot: cloneClickHouseTableCreateDraft(initialDraft),
            conflictRemoteSchema: null,
            pendingColumnAction: null,
        }),
        [initialDraft],
    );
    const storedDesignState = useTabRuntimeStateStore(
        (state) => state.clickHouseTableDesignByTabId[tabId],
    );
    const designState =
        storedDesignState?.mode === "create"
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
    const getOrCreateSchemaDesignState = useTabRuntimeStateStore(
        (state) => state.getOrCreateSchemaDesignState,
    );
    const patchSchemaDesignState = useTabRuntimeStateStore(
        (state) => state.patchSchemaDesignState,
    );
    const setDirty = useWorkbenchTabsStore((state) => state.setDirty);
    const setExecuting = useWorkbenchTabsStore((state) => state.setExecuting);
    const setToolbar = useContentToolbarStore((state) => state.setToolbar);
    const clearToolbar = useContentToolbarStore((state) => state.clearToolbar);
    const [isDdlDrawerOpen, setIsDdlDrawerOpen] = useState(false);
    const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
    const drawerContainerRef = useRef<HTMLDivElement>(null);
    const draft = designState.draft;
    const snapshot = designState.snapshot;
    const issues = useMemo(
        () => validateClickHouseTableCreateDraft(draft),
        [draft],
    );
    const isDirty = useMemo(
        () => draftIdentityKey(draft) !== draftIdentityKey(snapshot),
        [draft, snapshot],
    );
    const previewState = useClickHouseTableCreatePreview({
        profileId,
        tabId,
        draft,
        issues,
        enabled: isActive,
    });
    const saveState = useClickHouseTableCreateSave({
        tabId,
        profileId,
        tabRuntimeId,
        target: previewState.target,
        targetKey: previewState.targetKey,
        preview: previewState.preview,
        previewTargetKey: previewState.previewTargetKey,
        issues,
        isPreviewPending: previewState.isPending,
        previewErrorMessage: previewState.errorMessage,
    });
    const ddlText = useMemo(
        () =>
            joinSchemaDdlStatements(previewState.preview?.statements ?? []),
        [previewState.preview?.statements],
    );

    useEffect(() => {
        getOrCreateClickHouseTableDesignState(tabId, {
            mode: "create",
            draft: initialDraft,
        });
        getOrCreateSchemaDesignState(tabId, {
            mode: "create",
            loadState: "ready",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: null,
            isDirty: false,
        });
        return () => setExecuting(tabId, false);
    }, [
        getOrCreateClickHouseTableDesignState,
        getOrCreateSchemaDesignState,
        initialDraft,
        setExecuting,
        tabId,
    ]);

    useEffect(() => {
        setDirty(tabId, isDirty);
        patchSchemaDesignState(tabId, {
            mode: "create",
            loadState: "ready",
            blockerCount: issues.length,
            isDirty,
        });
    }, [
        isDirty,
        issues.length,
        patchSchemaDesignState,
        setDirty,
        tabId,
    ]);

    useEffect(() => {
        setExecuting(
            tabId,
            previewState.isPending || saveState.isApplying,
        );
    }, [
        previewState.isPending,
        saveState.isApplying,
        setExecuting,
        tabId,
    ]);

    const handleDraftChange = useCallback(
        (nextDraft: ClickHouseTableCreateDraft) => {
            if (
                !useTabRuntimeStateStore.getState()
                    .clickHouseTableDesignByTabId[tabId]
            ) {
                getOrCreateClickHouseTableDesignState(tabId, {
                    mode: "create",
                    draft: initialDraft,
                });
            }
            patchClickHouseTableDesignState(tabId, {
                mode: "create",
                draft: nextDraft,
            });
        },
        [
            getOrCreateClickHouseTableDesignState,
            initialDraft,
            patchClickHouseTableDesignState,
            tabId,
        ],
    );

    const handleTableNameChange = useCallback(
        (value: string) => {
            const next = cloneClickHouseTableCreateDraft(draft);
            next.name = value;
            handleDraftChange(next);
        },
        [draft, handleDraftChange],
    );

    const handleOpenDdlPreview = useCallback(() => {
        if (
            operationState === "outcomeUnknown" ||
            previewState.errorMessage != null
        ) {
            previewState.refreshPreview();
        }
        setIsDdlDrawerOpen(true);
    }, [
        operationState,
        previewState.errorMessage,
        previewState.refreshPreview,
    ]);

    const handleReset = useCallback(() => {
        resetClickHouseTableDesignDraft(tabId);
        patchSchemaDesignState(tabId, {
            mode: "create",
            operationState: "idle",
            isDirty: false,
            errorMessage: null,
        });
        setIsResetConfirmOpen(false);
    }, [patchSchemaDesignState, resetClickHouseTableDesignDraft, tabId]);

    const handleCopyDdl = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(ddlText);
            toast.success("DDL 已复制");
        } catch (error) {
            console.error("Failed to copy ClickHouse create DDL", error);
            toast.error("复制 DDL 失败");
        }
    }, [ddlText]);

    const handleExportDdl = useCallback(() => {
        const blob = new Blob([ddlText], { type: "text/sql;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${safeDownloadName(draft.name)}.sql`;
        anchor.click();
        URL.revokeObjectURL(url);
    }, [ddlText, draft.name]);

    useEffect(() => {
        setToolbar(tabId, {
            actions: [
                {
                    id: "save",
                    icon: Save,
                    label: "保存创建",
                    title: "使用当前已确认的 DDL 计划创建 ClickHouse 表",
                    variant: "default",
                    disabled: !saveState.canSave,
                    onClick: () => void saveState.handleSave(),
                },
                {
                    id: "previewDdl",
                    icon: FileCode2,
                    label: "DDL 预览",
                    title: "查看当前 ClickHouse CREATE TABLE 计划",
                    onClick: handleOpenDdlPreview,
                },
                {
                    id: "resetDesign",
                    icon: Undo2,
                    label: "重置草稿",
                    title: "恢复打开标签页时的创建草稿",
                    disabled: !isDirty || saveState.isApplying,
                    onClick: () => setIsResetConfirmOpen(true),
                },
            ],
            context: {
                icon: TableProperties,
                label: draft.name
                    ? `新建 ClickHouse 表 | ${draft.name}`
                    : `新建 ClickHouse 表 | ${draft.database}`,
            },
        });
        return () => clearToolbar(tabId);
    }, [
        clearToolbar,
        draft.database,
        draft.name,
        handleOpenDdlPreview,
        isDirty,
        saveState.canSave,
        saveState.handleSave,
        saveState.isApplying,
        setToolbar,
        tabId,
    ]);

    return (
        <>
            <div
                ref={drawerContainerRef}
                className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
                <ClickHouseTableCreateHeader
                    draft={draft}
                    issues={issues}
                    isDirty={isDirty}
                    operationState={operationState}
                    disabled={saveState.isApplying}
                    onTableNameChange={handleTableNameChange}
                />
                <Tabs
                    defaultValue="columns"
                    className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
                >
                    <div className="min-w-0 shrink-0 overflow-x-auto border-b px-3 py-1">
                        <TabsList className="h-7 min-w-max" variant="line">
                            <TabsTrigger value="columns" className="text-xs">
                                Columns
                                <span className="text-muted-foreground">
                                    {draft.columns.length}
                                </span>
                            </TabsTrigger>
                            <TabsTrigger value="engine_keys" className="text-xs">
                                Engine & Keys
                            </TabsTrigger>
                            <TabsTrigger value="ttl_settings" className="text-xs">
                                TTL & Settings
                                <span className="text-muted-foreground">
                                    {draft.settings.length}
                                </span>
                            </TabsTrigger>
                        </TabsList>
                    </div>
                    <TabsContent value="columns" className="min-h-0 flex-1 p-0">
                        <ScrollArea className="h-full">
                            <div className="p-3">
                                <ClickHouseColumnsCreate
                                    draft={draft}
                                    issues={issues}
                                    disabled={saveState.isApplying}
                                    onChange={handleDraftChange}
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
                                <ClickHouseEngineKeysCreate
                                    draft={draft}
                                    issues={issues}
                                    disabled={saveState.isApplying}
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
                                <ClickHouseTtlSettingsCreate
                                    draft={draft}
                                    issues={issues}
                                    disabled={saveState.isApplying}
                                    onChange={handleDraftChange}
                                />
                            </div>
                        </ScrollArea>
                    </TabsContent>
                </Tabs>
                <SchemaDdlPreviewDrawer
                    isOpen={isDdlDrawerOpen}
                    onOpenChange={setIsDdlDrawerOpen}
                    containerRef={drawerContainerRef.current}
                    title="ClickHouse DDL 预览"
                    description={`即将创建 ${draft.database}.${draft.name || "未命名表"}。保存只使用与当前草稿匹配的 plan hash。`}
                    statements={previewState.preview?.statements ?? []}
                    warnings={previewState.preview?.warnings ?? []}
                    validationMessages={issues.map((issue) => issue.message)}
                    isPending={previewState.isPending}
                    errorMessage={previewState.errorMessage}
                    onCopy={() => void handleCopyDdl()}
                    onExport={handleExportDdl}
                />
            </div>
            <AlertDialog
                open={isResetConfirmOpen}
                onOpenChange={setIsResetConfirmOpen}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>重置创建草稿？</AlertDialogTitle>
                        <AlertDialogDescription>
                            当前未保存的 ClickHouse 表结构修改将恢复为标签页初始状态。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={handleReset}>
                            确认重置
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
};
