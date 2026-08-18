import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useGroupRef, type Layout } from "react-resizable-panels";

import { Button } from "@/components/ui/button";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import {
    useKeyTree,
    useKeyValue,
} from "@/hooks/queries/use-db-metadata";
import { formatIpcError } from "@/lib/ipc-error";
import {
    useTabRuntimeStateStore,
    useWorkbenchTabsStore,
    type KeyValuePendingDeleteTarget,
    type KeyValueRuntimeState,
} from "@/store";
import type { RedisKeyTreeNode } from "@/types/ipc";
import { isUtf8RedisStringValue, resolveStringPreviewMode } from "../redis-value-preview";
import { CreateKeyDialog } from "./CreateKeyDialog";
import { KeyValueConfirmDialogs } from "./KeyValueConfirmDialogs";
import { RedisKeyTreePanel } from "./RedisKeyTreePanel";
import { RedisValueEditor } from "./RedisValueEditor";
import {
    collectPrefixIds,
    createEditableDraft,
    getCollectionLength,
    isCreateDraftDirty,
    isEditableCollectionValue,
    stableEditableValue,
    toEditableDraftValue,
    validateCreateDraft,
    validateEditableDraft,
} from "./redis-key-value-utils";
import { useRedisKeyValueActions } from "./useRedisKeyValueActions";
import { useRedisKeyValueDrafts } from "./useRedisKeyValueDrafts";
import { useRedisKeyValueToolbar } from "./useRedisKeyValueToolbar";

const DEFAULT_PATTERN = "*";
const DEFAULT_COUNT = 100;
const EMPTY_KEY_TREE: RedisKeyTreeNode[] = [];

interface KeyValueViewProps {
    tabId: string;
    profileId: string;
    dbIndex: number;
    pattern?: string;
    selectedKey?: string;
    isActive?: boolean;
}

export function KeyValueView({
    tabId,
    profileId,
    dbIndex,
    pattern = DEFAULT_PATTERN,
    selectedKey,
    isActive = true,
}: KeyValueViewProps) {
    const groupRef = useGroupRef();
    const [ttlInput, setTtlInput] = useState("");
    const [isTtlPopoverOpen, setIsTtlPopoverOpen] = useState(false);
    const [isCreateTtlPopoverOpen, setIsCreateTtlPopoverOpen] = useState(false);
    const [ttlTick, setTtlTick] = useState(0);
    const [selectedCollectionRowIndex, setSelectedCollectionRowIndex] =
        useState<number | null>(null);
    const [selectedCreateCollectionRowIndex, setSelectedCreateCollectionRowIndex] =
        useState<number | null>(null);
    const [contextMenuTarget, setContextMenuTarget] =
        useState<KeyValuePendingDeleteTarget | null>(null);
    const [deleteTargetForConfirm, setDeleteTargetForConfirm] =
        useState<KeyValuePendingDeleteTarget | null>(null);
    const ttlBaselineRef = useRef<{
        key: string;
        ttl: number;
        loadedAt: number;
    } | null>(null);
    const runtimeFallback = useMemo<KeyValueRuntimeState>(
        () => ({
            cursor: 0,
            activeKey: selectedKey ?? null,
            collapsedFolderIds: new Set(),
            collapsedFolderTreeKey: null,
            isPreviewCollapsed: selectedKey == null,
            stringPreviewMode: null,
            valueDraft: null,
            isCreateDialogOpen: false,
            createDraft: null,
            pendingDeleteTarget: null,
            pendingKeySwitch: null,
            pendingRefreshDiscard: null,
        }),
        [selectedKey],
    );
    const runtimeState =
        useTabRuntimeStateStore((state) => state.keyValueByTabId[tabId]) ??
        runtimeFallback;
    const getOrCreateKeyValueState = useTabRuntimeStateStore(
        (state) => state.getOrCreateKeyValueState,
    );
    const patchKeyValueState = useTabRuntimeStateStore(
        (state) => state.patchKeyValueState,
    );
    const {
        activeKey,
        collapsedFolderIds,
        collapsedFolderTreeKey,
        isPreviewCollapsed,
        stringPreviewMode,
        valueDraft,
        isCreateDialogOpen,
        createDraft,
        pendingDeleteTarget,
        pendingKeySwitch,
        pendingRefreshDiscard,
    } = runtimeState;
    const setExecuting = useWorkbenchTabsStore((state) => state.setExecuting);
    const setDirty = useWorkbenchTabsStore((state) => state.setDirty);

    useEffect(() => {
        getOrCreateKeyValueState(tabId, { activeKey: selectedKey ?? null });
    }, [getOrCreateKeyValueState, selectedKey, tabId]);

    useEffect(() => {
        if (selectedKey && activeKey == null) {
            patchKeyValueState(tabId, {
                activeKey: selectedKey,
                isPreviewCollapsed: false,
                stringPreviewMode: null,
                valueDraft: null,
            });
        }
    }, [activeKey, patchKeyValueState, selectedKey, tabId]);

    const setCollapsedFolderIds = useCallback(
        (updater: (current: Set<string>) => Set<string>) => {
            patchKeyValueState(tabId, (current) => ({
                collapsedFolderIds: updater(current.collapsedFolderIds),
            }));
        },
        [patchKeyValueState, tabId],
    );

    const request = useMemo(
        () => ({ dbIndex, pattern, count: DEFAULT_COUNT }),
        [dbIndex, pattern],
    );
    const visiblePatternLabel = useMemo(() => {
        const trimmed = pattern.trim();
        if (!trimmed || trimmed === "*") return null;
        return trimmed;
    }, [pattern]);

    const { data, isLoading, isFetching, isError, error, refetch } = useKeyTree(profileId, request);
    const keyTree = data?.nodes ?? EMPTY_KEY_TREE;
    const prefixIds = useMemo(() => collectPrefixIds(keyTree), [keyTree]);
    const treeStateKey = useMemo(
        () => `${dbIndex}:${pattern}:${prefixIds.join("|")}`,
        [dbIndex, pattern, prefixIds],
    );
    const resolvedKey = activeKey;
    const detail = useKeyValue(
        profileId,
        resolvedKey ? { dbIndex, key: resolvedKey } : null,
    );
    const refetchDetail = detail.refetch;
    const displayTtl = useMemo(() => {
        if (!detail.data) return null;
        if (detail.data.ttl <= 0) return detail.data.ttl;

        const baseline = ttlBaselineRef.current;
        if (
            !baseline ||
            baseline.key !== detail.data.key ||
            baseline.ttl !== detail.data.ttl
        ) {
            return detail.data.ttl;
        }

        const elapsedSeconds = Math.floor(
            (Date.now() - baseline.loadedAt) / 1000,
        );
        return Math.max(0, detail.data.ttl - elapsedSeconds);
    }, [detail.data, ttlTick]);
    const effectiveStringPreviewMode = useMemo(
        () => resolveStringPreviewMode(detail.data?.value, stringPreviewMode),
        [detail.data?.value, stringPreviewMode],
    );
    const showStringPreviewModes = isUtf8RedisStringValue(detail.data?.value);
    const isEditableValue =
        detail.data?.key != null &&
        detail.data.value != null &&
        toEditableDraftValue(detail.data.value, effectiveStringPreviewMode) != null;
    const isValueDraftDirty =
        valueDraft != null &&
        (valueDraft.keyDraft !== valueDraft.baseKey ||
            stableEditableValue(valueDraft.valueDraft) !==
                stableEditableValue(valueDraft.baseValue));
    const isCreateKeyDirty = isCreateDraftDirty(createDraft);
    const valueDraftValidationError = validateEditableDraft(valueDraft);
    const createDraftValidationError = validateCreateDraft(createDraft);
    const {
        isMutating,
        isDeletePending,
        canSaveValue,
        canSaveCreateKey,
        isCreatePending,
        isTtlPending,
        handleRefresh,
        handleRefreshCurrentKey,
        requestDeleteTarget,
        handleTogglePreview,
        handleStringPreviewModeChange,
        handleCancelValueDraft,
        handleOpenCreateDialog,
        handleCancelCreateDraft,
        handleCreateDialogOpenChange,
        handleSaveValueDraft,
        handleSaveCreateDraft,
        handleTtlPopoverOpenChange,
        handleSaveTtl,
        handlePersistTtl,
        requestActiveKey,
        handleDiscardDialogOpenChange,
        handleConfirmDiscard,
        handleDeleteDialogOpenChange,
        handleConfirmDelete,
        handleDeleteCurrentKey,
    } = useRedisKeyValueActions({
        tabId,
        profileId,
        dbIndex,
        resolvedKey,
        activeKey,
        isPreviewCollapsed,
        stringPreviewMode,
        valueDraft,
        createDraft,
        pendingKeySwitch,
        pendingRefreshDiscard,
        pendingDeleteTarget,
        deleteTargetForConfirm,
        isEditableValue,
        isValueDraftDirty,
        isCreateKeyDirty,
        valueDraftValidationError,
        createDraftValidationError,
        hasDetailData: Boolean(detail.data),
        detailFingerprint: detail.data?.fingerprint ?? null,
        displayTtl,
        ttlInput,
        patchKeyValueState,
        setDeleteTargetForConfirm,
        setIsCreateTtlPopoverOpen,
        setSelectedCreateCollectionRowIndex,
        setIsTtlPopoverOpen,
        setTtlInput,
        refetch,
        refetchDetail,
    });
    const isExecuting = isFetching || detail.isFetching || isMutating;
    const editableCollectionValue = isEditableCollectionValue(valueDraft?.valueDraft)
        ? valueDraft.valueDraft
        : null;
    const createCollectionValue = isEditableCollectionValue(createDraft?.valueDraft)
        ? createDraft.valueDraft
        : null;
    const editableCollectionRowCount = editableCollectionValue
        ? getCollectionLength(editableCollectionValue)
        : 0;
    const createCollectionRowCount = createCollectionValue
        ? getCollectionLength(createCollectionValue)
        : 0;
    const showCollectionActions =
        isEditableValue && editableCollectionValue != null;
    const canAddCollectionRow = showCollectionActions && !isMutating;
    const canDeleteCollectionRow =
        canAddCollectionRow &&
        selectedCollectionRowIndex != null &&
        selectedCollectionRowIndex >= 0 &&
        selectedCollectionRowIndex < editableCollectionRowCount;
    const canAddCreateCollectionRow = createCollectionValue != null && !isMutating;
    const canDeleteCreateCollectionRow =
        canAddCreateCollectionRow &&
        selectedCreateCollectionRowIndex != null &&
        selectedCreateCollectionRowIndex >= 0 &&
        selectedCreateCollectionRowIndex < createCollectionRowCount;
    const pendingDiscardOpen =
        pendingKeySwitch != null ||
        pendingRefreshDiscard != null ||
        pendingDeleteTarget != null;

    useEffect(() => {
        setExecuting(tabId, isExecuting);
    }, [isExecuting, setExecuting, tabId]);

    useEffect(() => {
        setDirty(tabId, isValueDraftDirty || isCreateKeyDirty);
    }, [isCreateKeyDirty, isValueDraftDirty, setDirty, tabId]);

    useEffect(() => {
        setSelectedCollectionRowIndex(null);
    }, [resolvedKey, valueDraft?.valueKind]);

    useEffect(() => {
        setSelectedCreateCollectionRowIndex(null);
    }, [createDraft?.valueKind, isCreateDialogOpen]);

    useEffect(() => {
        if (
            selectedCollectionRowIndex != null &&
            selectedCollectionRowIndex >= editableCollectionRowCount
        ) {
            setSelectedCollectionRowIndex(null);
        }
    }, [editableCollectionRowCount, selectedCollectionRowIndex]);

    useEffect(() => {
        if (
            selectedCreateCollectionRowIndex != null &&
            selectedCreateCollectionRowIndex >= createCollectionRowCount
        ) {
            setSelectedCreateCollectionRowIndex(null);
        }
    }, [createCollectionRowCount, selectedCreateCollectionRowIndex]);

    useEffect(() => {
        if (!detail.data) {
            ttlBaselineRef.current = null;
            return;
        }

        ttlBaselineRef.current = {
            key: detail.data.key,
            ttl: detail.data.ttl,
            loadedAt: Date.now(),
        };
        setTtlTick((current) => current + 1);
    }, [detail.data?.key, detail.data?.ttl, detail.dataUpdatedAt]);

    useEffect(() => {
        if (!detail.data || detail.data.ttl <= 0) return;

        const intervalId = window.setInterval(() => {
            setTtlTick((current) => current + 1);
        }, 1000);

        return () => window.clearInterval(intervalId);
    }, [detail.data?.key, detail.data?.ttl]);

    useEffect(() => {
        if (!detail.data) {
            if (valueDraft && !isValueDraftDirty) {
                patchKeyValueState(tabId, { valueDraft: null });
            }
            return;
        }

        const nextDraft = createEditableDraft({
            key: detail.data.key,
            fingerprint: detail.data.fingerprint,
            value: detail.data.value,
            mode: effectiveStringPreviewMode,
        });

        if (!nextDraft) {
            if (valueDraft && !isValueDraftDirty) {
                patchKeyValueState(tabId, { valueDraft: null });
            }
            return;
        }

        const shouldReplaceDraft =
            valueDraft == null ||
            valueDraft.sourceKey !== detail.data.key ||
            valueDraft.valueKind !== nextDraft.valueKind ||
            (!isValueDraftDirty &&
                (valueDraft.baseKey !== nextDraft.baseKey ||
                    valueDraft.keyDraft !== nextDraft.keyDraft ||
                    stableEditableValue(valueDraft.baseValue) !==
                        stableEditableValue(nextDraft.baseValue) ||
                    stableEditableValue(valueDraft.valueDraft) !==
                        stableEditableValue(nextDraft.valueDraft)));

        if (shouldReplaceDraft) {
            patchKeyValueState(tabId, { valueDraft: nextDraft });
        }
    }, [
        detail.data,
        effectiveStringPreviewMode,
        isValueDraftDirty,
        patchKeyValueState,
        valueDraft,
        tabId,
    ]);

    useEffect(() => {
        if (!data || collapsedFolderTreeKey === treeStateKey) return;

        patchKeyValueState(tabId, (current) => ({
            collapsedFolderIds: new Set(prefixIds),
            collapsedFolderTreeKey: treeStateKey,
            isPreviewCollapsed:
                current.activeKey == null ? true : current.isPreviewCollapsed,
        }));
    }, [
        collapsedFolderTreeKey,
        data,
        patchKeyValueState,
        prefixIds,
        tabId,
        treeStateKey,
    ]);

    useEffect(() => {
        groupRef.current?.setLayout({
            keyBrowserPanel: isPreviewCollapsed ? 100 : 65,
            keyPreviewPanel: isPreviewCollapsed ? 0 : 35,
        });
    }, [groupRef, isPreviewCollapsed]);

    const {
        handleValueDraftChange,
        handleAddCollectionRow,
        handleDeleteCollectionRow,
        handleKeyDraftChange,
        handleCreateKeyDraftChange,
        handleCreateValueKindChange,
        handleCreateTtlDraftChange,
        handleCreateValueDraftChange,
        handleAddCreateCollectionRow,
        handleDeleteCreateCollectionRow,
    } = useRedisKeyValueDrafts({
        tabId,
        patchKeyValueState,
        editableCollectionValue,
        selectedCollectionRowIndex,
        setSelectedCollectionRowIndex,
        createCollectionValue,
        selectedCreateCollectionRowIndex,
        setSelectedCreateCollectionRowIndex,
    });

    const handleLayoutChanged = useCallback(
        (layout: Layout) => {
            const previewSize = layout.keyPreviewPanel ?? 0;
            const nextCollapsed = previewSize <= 0;

            if (nextCollapsed !== isPreviewCollapsed) {
                patchKeyValueState(tabId, { isPreviewCollapsed: nextCollapsed });
            }
        },
        [isPreviewCollapsed, patchKeyValueState, tabId],
    );

    useRedisKeyValueToolbar({
        tabId,
        profileId,
        dbIndex,
        isCreateDialogOpen,
        isCreatePending,
        isFetching,
        isPreviewCollapsed,
        onOpenCreateDialog: handleOpenCreateDialog,
        onRefresh: handleRefresh,
        onTogglePreview: handleTogglePreview,
    });

    const toggleFolder = useCallback((nodeId: string) => {
        setCollapsedFolderIds((current) => {
            const next = new Set(current);
            if (next.has(nodeId)) {
                next.delete(nodeId);
            } else {
                next.add(nodeId);
            }
            return next;
        });
    }, [setCollapsedFolderIds]);

    if (isLoading && !data) {
        return (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                加载 Redis keys...
            </div>
        );
    }

    if (isError) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <p className="text-sm text-destructive">
                    加载失败：{formatIpcError(error)}
                </p>
                <Button variant="outline" size="sm" onClick={handleRefresh}>
                    <RefreshCw className="mr-1 size-3.5" />
                    重试
                </Button>
            </div>
        );
    }

    return (
        <>
            <ResizablePanelGroup
                id={`keyValueLayout-${tabId}`}
                className="h-full min-h-0"
                orientation="horizontal"
                groupRef={groupRef}
                onLayoutChanged={handleLayoutChanged}
            >
                <ResizablePanel
                    id="keyBrowserPanel"
                    defaultSize="65%"
                    minSize="220px"
                    groupResizeBehavior="preserve-pixel-size"
                >
                    <RedisKeyTreePanel
                        dbIndex={dbIndex}
                        visiblePatternLabel={visiblePatternLabel}
                        keyTree={keyTree}
                        totalKeyCount={data?.totalKeyCount ?? 0}
                        folderCount={prefixIds.length}
                        activeKey={resolvedKey}
                        collapsedFolderIds={collapsedFolderIds}
                        contextMenuTarget={contextMenuTarget}
                        isFetching={isFetching}
                        isCreatePending={isCreatePending}
                        isDeletePending={isDeletePending}
                        onContextMenuTargetChange={setContextMenuTarget}
                        onRequestActiveKey={requestActiveKey}
                        onToggleFolder={toggleFolder}
                        onOpenCreateDialog={handleOpenCreateDialog}
                        onRefresh={handleRefresh}
                        onRequestDeleteTarget={requestDeleteTarget}
                    />
                </ResizablePanel>

                <ResizableHandle withHandle />

                <ResizablePanel
                    id="keyPreviewPanel"
                    defaultSize={selectedKey ? "35%" : "0%"}
                    minSize="220px"
                    collapsible
                    groupResizeBehavior="preserve-pixel-size"
                >
                    <RedisValueEditor
                        tabId={tabId}
                        isActive={isActive}
                        resolvedKey={resolvedKey}
                        valueType={detail.data?.valueType}
                        value={detail.data?.value}
                        size={detail.data?.size}
                        isLoading={detail.isLoading}
                        isError={detail.isError}
                        error={detail.error}
                        isFetching={detail.isFetching}
                        isEditableValue={isEditableValue}
                        valueDraft={valueDraft}
                        selectedCollectionRowIndex={selectedCollectionRowIndex}
                        validationError={valueDraftValidationError}
                        effectiveStringPreviewMode={effectiveStringPreviewMode}
                        showStringPreviewModes={showStringPreviewModes}
                        isTtlPopoverOpen={isTtlPopoverOpen}
                        ttlInput={ttlInput}
                        displayTtl={displayTtl}
                        isTtlPending={isTtlPending}
                        canSaveValue={canSaveValue}
                        isValueDraftDirty={isValueDraftDirty}
                        isMutating={isMutating}
                        showCollectionActions={showCollectionActions}
                        canAddCollectionRow={canAddCollectionRow}
                        canDeleteCollectionRow={canDeleteCollectionRow}
                        isDeletePending={isDeletePending}
                        onTtlPopoverOpenChange={handleTtlPopoverOpenChange}
                        onTtlInputChange={setTtlInput}
                        onSaveTtl={handleSaveTtl}
                        onPersistTtl={handlePersistTtl}
                        onSaveValueDraft={handleSaveValueDraft}
                        onCancelValueDraft={handleCancelValueDraft}
                        onRefreshCurrentKey={handleRefreshCurrentKey}
                        onDeleteCurrentKey={handleDeleteCurrentKey}
                        onStringPreviewModeChange={handleStringPreviewModeChange}
                        onAddCollectionRow={handleAddCollectionRow}
                        onDeleteCollectionRow={handleDeleteCollectionRow}
                        onValueDraftChange={handleValueDraftChange}
                        onSelectedCollectionRowIndexChange={
                            setSelectedCollectionRowIndex
                        }
                        onKeyDraftChange={handleKeyDraftChange}
                    />
                </ResizablePanel>
            </ResizablePanelGroup>
            <CreateKeyDialog
                tabId={tabId}
                isActive={isActive}
                isCreateDialogOpen={isCreateDialogOpen}
                createDraft={createDraft}
                isCreateKeyDirty={isCreateKeyDirty}
                createDraftValidationError={createDraftValidationError}
                canSaveCreateKey={canSaveCreateKey}
                canAddCreateCollectionRow={canAddCreateCollectionRow}
                canDeleteCreateCollectionRow={canDeleteCreateCollectionRow}
                selectedCreateCollectionRowIndex={selectedCreateCollectionRowIndex}
                isCreateTtlPopoverOpen={isCreateTtlPopoverOpen}
                isCreatePending={isCreatePending}
                onOpenChange={handleCreateDialogOpenChange}
                onKeyDraftChange={handleCreateKeyDraftChange}
                onValueKindChange={handleCreateValueKindChange}
                onTtlDraftChange={handleCreateTtlDraftChange}
                onValueDraftChange={handleCreateValueDraftChange}
                onAddCollectionRow={handleAddCreateCollectionRow}
                onDeleteCollectionRow={handleDeleteCreateCollectionRow}
                onSave={handleSaveCreateDraft}
                onCancel={handleCancelCreateDraft}
                onCreateTtlPopoverOpenChange={setIsCreateTtlPopoverOpen}
                onSelectedCreateCollectionRowIndexChange={setSelectedCreateCollectionRowIndex}
            />
            <KeyValueConfirmDialogs
                pendingDiscardOpen={pendingDiscardOpen}
                deleteTargetForConfirm={deleteTargetForConfirm}
                isDeletePending={isDeletePending}
                onDiscardDialogOpenChange={handleDiscardDialogOpenChange}
                onConfirmDiscard={handleConfirmDiscard}
                onDeleteDialogOpenChange={handleDeleteDialogOpenChange}
                onConfirmDelete={handleConfirmDelete}
            />
        </>
    );
}
