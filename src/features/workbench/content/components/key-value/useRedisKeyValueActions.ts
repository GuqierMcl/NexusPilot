import {
    useCallback,
    type Dispatch,
    type SetStateAction,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import {
    useCreateKeyValue,
    useDeleteKey,
    useDeleteKeyPrefix,
    useRenameKey,
    useSetKeyTtl,
    useSetKeyValue,
} from "@/hooks/queries/use-db-metadata";
import { useExplorerMetadataStore } from "@/features/workbench/explorer/useExplorerMetadataStore";
import { queryKeys } from "@/lib/query-keys";
import { apiInvoke } from "@/lib/api-client";
import {
    useExplorerStore,
    useTabRuntimeStateStore,
    type KeyValueCreateDraft,
    type KeyValuePendingDeleteTarget,
    type KeyValueRuntimeState,
} from "@/store";
import { useConnectionSessionStore } from "@/store/slices/connection-session-slice";
import type { ExplorerTreeConnectionNode } from "@/features/workbench/explorer/types";
import type { RedisKeyValue } from "@/types/ipc";

import {
    cloneEditableValue,
    createDefaultCreateDraft,
    expectedTypeForEditableValue,
} from "./redis-key-value-utils";

type PatchKeyValueState = ReturnType<
    typeof useTabRuntimeStateStore.getState
>["patchKeyValueState"];

type RefetchFn = () => unknown;
type PendingRefreshAction = "all" | "current" | null;

interface UseRedisKeyValueActionsOptions {
    tabId: string;
    profileId: string;
    dbIndex: number;
    resolvedKey: string | null;
    activeKey: string | null;
    isPreviewCollapsed: boolean;
    stringPreviewMode: KeyValueRuntimeState["stringPreviewMode"];
    valueDraft: KeyValueRuntimeState["valueDraft"];
    createDraft: KeyValueCreateDraft | null;
    pendingKeySwitch: string | null;
    pendingRefreshDiscard: PendingRefreshAction;
    pendingDeleteTarget: KeyValuePendingDeleteTarget | null;
    deleteTargetForConfirm: KeyValuePendingDeleteTarget | null;
    isEditableValue: boolean;
    isValueDraftDirty: boolean;
    isCreateKeyDirty: boolean;
    valueDraftValidationError: string | null;
    createDraftValidationError: string | null;
    hasDetailData: boolean;
    detailFingerprint: string | null;
    displayTtl: number | null;
    ttlInput: string;
    patchKeyValueState: PatchKeyValueState;
    setDeleteTargetForConfirm: Dispatch<
        SetStateAction<KeyValuePendingDeleteTarget | null>
    >;
    setIsCreateTtlPopoverOpen: Dispatch<SetStateAction<boolean>>;
    setSelectedCreateCollectionRowIndex: Dispatch<
        SetStateAction<number | null>
    >;
    setIsTtlPopoverOpen: Dispatch<SetStateAction<boolean>>;
    setTtlInput: Dispatch<SetStateAction<string>>;
    refetch: RefetchFn;
    refetchDetail: RefetchFn;
}

export function useRedisKeyValueActions({
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
    hasDetailData,
    detailFingerprint,
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
}: UseRedisKeyValueActionsOptions) {
    const queryClient = useQueryClient();
    const createKeyValueMutation = useCreateKeyValue(profileId);
    const setKeyValueMutation = useSetKeyValue(profileId);
    const renameKeyMutation = useRenameKey(profileId);
    const setKeyTtlMutation = useSetKeyTtl(profileId);
    const deleteKeyMutation = useDeleteKey(profileId);
    const deleteKeyPrefixMutation = useDeleteKeyPrefix(profileId);

    const isMutating =
        createKeyValueMutation.isPending ||
        setKeyValueMutation.isPending ||
        renameKeyMutation.isPending ||
        setKeyTtlMutation.isPending ||
        deleteKeyMutation.isPending ||
        deleteKeyPrefixMutation.isPending;
    const isDeletePending =
        deleteKeyMutation.isPending || deleteKeyPrefixMutation.isPending;
    const canSaveValue =
        isEditableValue &&
        isValueDraftDirty &&
        valueDraftValidationError == null &&
        !isMutating;
    const canSaveCreateKey =
        createDraft != null &&
        isCreateKeyDirty &&
        createDraftValidationError == null &&
        !isMutating;

    const invalidateRedisQueries = useCallback(async () => {
        await queryClient.invalidateQueries({
            queryKey: queryKeys.profile(profileId),
        });
    }, [profileId, queryClient]);

    const refreshExplorerDbCounts = useCallback(() => {
        const metadataStore = useExplorerMetadataStore.getState();
        const wasRootLoaded = Object.prototype.hasOwnProperty.call(
            metadataStore.loadedChildren,
            profileId,
        );
        metadataStore.clearForProfile(profileId);

        if (!wasRootLoaded) {
            return;
        }

        const session = useConnectionSessionStore.getState().sessions[profileId];
        if (session?.status !== "connected") {
            return;
        }

        const connection = useExplorerStore
            .getState()
            .connections.find((item) => item.id === profileId);
        if (!connection) {
            return;
        }

        const connectionNode: ExplorerTreeConnectionNode = {
            id: connection.id,
            label: connection.name,
            type: "connection",
            status: connection.lastConnectionStatus ?? "unknown",
            connection,
        };

        void useExplorerMetadataStore.getState().loadChildren(connectionNode);
    }, [profileId]);

    const performRefresh = useCallback(
        (action: Exclude<PendingRefreshAction, null>) => {
            if (action === "all") {
                void refetch();
            }
            if (resolvedKey) {
                void refetchDetail();
            }
        },
        [refetch, refetchDetail, resolvedKey],
    );

    const requestRefresh = useCallback(
        (action: Exclude<PendingRefreshAction, null>) => {
            if (isValueDraftDirty || isCreateKeyDirty) {
                patchKeyValueState(tabId, {
                    pendingRefreshDiscard: action,
                    pendingKeySwitch: null,
                    pendingDeleteTarget: null,
                });
                return;
            }
            performRefresh(action);
        },
        [
            isCreateKeyDirty,
            isValueDraftDirty,
            patchKeyValueState,
            performRefresh,
            tabId,
        ],
    );

    const handleRefresh = useCallback(() => {
        requestRefresh("all");
    }, [requestRefresh]);

    const handleRefreshCurrentKey = useCallback(() => {
        requestRefresh("current");
    }, [requestRefresh]);

    const requestDeleteTarget = useCallback(
        async (target: KeyValuePendingDeleteTarget) => {
            let preparedTarget = target;
            if (target.kind === "key" && !target.expectedFingerprint) {
                const expectedFingerprint =
                    target.key === valueDraft?.baseKey
                        ? valueDraft.baselineFingerprint
                        : target.key === resolvedKey
                          ? detailFingerprint
                          : (
                                await apiInvoke<RedisKeyValue>(
                                    "get_key_value",
                                    {
                                        profileId,
                                        keyRef: {
                                            dbIndex,
                                            key: target.key,
                                        },
                                    },
                                )
                            ).fingerprint;
                if (!expectedFingerprint) {
                    toast.error("无法建立 Redis key 的删除前置条件，请刷新后重试");
                    return;
                }
                preparedTarget = {
                    ...target,
                    expectedFingerprint,
                };
            }
            if (isValueDraftDirty || isCreateKeyDirty) {
                patchKeyValueState(tabId, {
                    pendingDeleteTarget: preparedTarget,
                    pendingKeySwitch: null,
                    pendingRefreshDiscard: null,
                });
                return;
            }
            setDeleteTargetForConfirm(preparedTarget);
        },
        [
            dbIndex,
            detailFingerprint,
            isCreateKeyDirty,
            isValueDraftDirty,
            patchKeyValueState,
            profileId,
            resolvedKey,
            setDeleteTargetForConfirm,
            tabId,
            valueDraft,
        ],
    );

    const handleTogglePreview = useCallback(() => {
        patchKeyValueState(tabId, (current) => ({
            isPreviewCollapsed: !current.isPreviewCollapsed,
        }));
    }, [patchKeyValueState, tabId]);

    const handleStringPreviewModeChange = useCallback(
        (mode: string) => {
            if (mode === "text" || mode === "json" || mode === "xml") {
                patchKeyValueState(tabId, { stringPreviewMode: mode });
            }
        },
        [patchKeyValueState, tabId],
    );

    const handleCancelValueDraft = useCallback(() => {
        if (!valueDraft) return;
        patchKeyValueState(tabId, {
            valueDraft: {
                ...valueDraft,
                keyDraft: valueDraft.baseKey,
                valueDraft: cloneEditableValue(valueDraft.baseValue),
            },
        });
    }, [patchKeyValueState, valueDraft, tabId]);

    const handleOpenCreateDialog = useCallback(() => {
        patchKeyValueState(tabId, (current) => ({
            isCreateDialogOpen: true,
            createDraft: current.createDraft ?? createDefaultCreateDraft(),
        }));
    }, [patchKeyValueState, tabId]);

    const handleCancelCreateDraft = useCallback(() => {
        patchKeyValueState(tabId, {
            isCreateDialogOpen: false,
            createDraft: null,
        });
        setIsCreateTtlPopoverOpen(false);
        setSelectedCreateCollectionRowIndex(null);
    }, [
        patchKeyValueState,
        setIsCreateTtlPopoverOpen,
        setSelectedCreateCollectionRowIndex,
        tabId,
    ]);

    const handleCreateDialogOpenChange = useCallback(
        (open: boolean) => {
            if (open) {
                handleOpenCreateDialog();
                return;
            }
            handleCancelCreateDraft();
        },
        [handleCancelCreateDraft, handleOpenCreateDialog],
    );

    const handleSaveValueDraft = useCallback(async () => {
        if (!valueDraft || !canSaveValue) return;

        let targetKey = valueDraft.baseKey;
        let nextDraft = valueDraft;

        if (valueDraft.keyDraft !== valueDraft.baseKey) {
            const renamed = await renameKeyMutation.mutateAsync({
                dbIndex,
                key: valueDraft.baseKey,
                newKey: valueDraft.keyDraft,
                expectedFingerprint: valueDraft.baselineFingerprint,
            });
            targetKey = renamed.key;
            nextDraft = {
                ...nextDraft,
                sourceKey: targetKey,
                baseKey: targetKey,
                keyDraft: targetKey,
                baselineFingerprint: renamed.fingerprint,
            };
            patchKeyValueState(tabId, {
                activeKey: targetKey,
                valueDraft: nextDraft,
            });
        }

        const saved = await setKeyValueMutation.mutateAsync({
            dbIndex,
            key: targetKey,
            value: nextDraft.valueDraft,
            expectedFingerprint: nextDraft.baselineFingerprint,
            expectedType: expectedTypeForEditableValue(nextDraft.valueDraft),
            ttlPolicy: "keep",
        });

        patchKeyValueState(tabId, {
            activeKey: targetKey,
            valueDraft: {
                sourceKey: targetKey,
                baseKey: targetKey,
                keyDraft: targetKey,
                baselineFingerprint: saved.fingerprint,
                valueKind: nextDraft.valueKind,
                baseValue: cloneEditableValue(nextDraft.valueDraft),
                valueDraft: cloneEditableValue(nextDraft.valueDraft),
            },
        });
        await invalidateRedisQueries();
        toast.success("Redis key 已保存");
    }, [
        canSaveValue,
        dbIndex,
        invalidateRedisQueries,
        patchKeyValueState,
        renameKeyMutation,
        setKeyValueMutation,
        valueDraft,
        tabId,
    ]);

    const handleSaveCreateDraft = useCallback(async () => {
        if (!createDraft || !canSaveCreateKey) return;

        const ttlText = createDraft.ttlSecondsDraft.trim();
        const ttlSeconds = ttlText.length > 0 ? Number(ttlText) : null;
        const created = await createKeyValueMutation.mutateAsync({
            dbIndex,
            key: createDraft.keyDraft,
            value: createDraft.valueDraft,
            ttlPolicy: ttlSeconds == null ? "persist" : "expire",
            ttlSeconds,
        });

        patchKeyValueState(tabId, {
            activeKey: created.key,
            isPreviewCollapsed: false,
            stringPreviewMode: null,
            valueDraft: null,
            isCreateDialogOpen: false,
            createDraft: null,
        });
        setIsCreateTtlPopoverOpen(false);
        setSelectedCreateCollectionRowIndex(null);
        await invalidateRedisQueries();
        refreshExplorerDbCounts();
        toast.success("Redis key 已创建");
    }, [
        canSaveCreateKey,
        createDraft,
        createKeyValueMutation,
        dbIndex,
        invalidateRedisQueries,
        patchKeyValueState,
        refreshExplorerDbCounts,
        setIsCreateTtlPopoverOpen,
        setSelectedCreateCollectionRowIndex,
        tabId,
    ]);

    const handleTtlPopoverOpenChange = useCallback(
        (open: boolean) => {
            setIsTtlPopoverOpen(open);
            if (open && hasDetailData) {
                setTtlInput(displayTtl != null && displayTtl > 0 ? String(displayTtl) : "");
            }
        },
        [displayTtl, hasDetailData, setIsTtlPopoverOpen, setTtlInput],
    );

    const handleSaveTtl = useCallback(async () => {
        if (!resolvedKey) return;
        const ttlSeconds = Number(ttlInput);
        if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
            toast.error("TTL 必须是正整数秒数");
            return;
        }
        await setKeyTtlMutation.mutateAsync({
            dbIndex,
            key: resolvedKey,
            expectedFingerprint:
                valueDraft?.baselineFingerprint ?? detailFingerprint ?? "",
            mode: "expire",
            ttlSeconds,
        });
        setIsTtlPopoverOpen(false);
        await refetchDetail();
        toast.success("TTL 已更新");
    }, [
        dbIndex,
        refetchDetail,
        resolvedKey,
        setIsTtlPopoverOpen,
        setKeyTtlMutation,
        ttlInput,
        valueDraft,
        detailFingerprint,
    ]);

    const handlePersistTtl = useCallback(async () => {
        if (!resolvedKey) return;
        await setKeyTtlMutation.mutateAsync({
            dbIndex,
            key: resolvedKey,
            expectedFingerprint:
                valueDraft?.baselineFingerprint ?? detailFingerprint ?? "",
            mode: "persist",
        });
        setIsTtlPopoverOpen(false);
        await refetchDetail();
        toast.success("TTL 已移除");
    }, [
        dbIndex,
        refetchDetail,
        resolvedKey,
        setIsTtlPopoverOpen,
        setKeyTtlMutation,
        valueDraft,
        detailFingerprint,
    ]);

    const requestActiveKey = useCallback(
        (nextKey: string) => {
            if (nextKey === resolvedKey) return;
            if (isValueDraftDirty || isCreateKeyDirty) {
                patchKeyValueState(tabId, {
                    pendingKeySwitch: nextKey,
                    pendingRefreshDiscard: null,
                    pendingDeleteTarget: null,
                });
                return;
            }
            patchKeyValueState(tabId, {
                activeKey: nextKey,
                isPreviewCollapsed: false,
                stringPreviewMode: null,
                valueDraft: null,
            });
        },
        [
            isCreateKeyDirty,
            isValueDraftDirty,
            patchKeyValueState,
            resolvedKey,
            tabId,
        ],
    );

    const handleDiscardDialogOpenChange = useCallback(
        (open: boolean) => {
            if (open) return;
            patchKeyValueState(tabId, {
                pendingKeySwitch: null,
                pendingRefreshDiscard: null,
                pendingDeleteTarget: null,
            });
        },
        [patchKeyValueState, tabId],
    );

    const handleConfirmDiscard = useCallback(() => {
        const nextKey = pendingKeySwitch;
        const refreshAction = pendingRefreshDiscard;
        const deleteTarget = pendingDeleteTarget;

        if (nextKey) {
            patchKeyValueState(tabId, {
                activeKey: nextKey,
                isPreviewCollapsed: false,
                stringPreviewMode: null,
                valueDraft: null,
                isCreateDialogOpen: false,
                createDraft: null,
                pendingKeySwitch: null,
                pendingRefreshDiscard: null,
                pendingDeleteTarget: null,
            });
            return;
        }

        if (refreshAction) {
            patchKeyValueState(tabId, {
                valueDraft: null,
                isCreateDialogOpen: false,
                createDraft: null,
                pendingKeySwitch: null,
                pendingRefreshDiscard: null,
                pendingDeleteTarget: null,
            });
            performRefresh(refreshAction);
            return;
        }

        if (deleteTarget) {
            patchKeyValueState(tabId, {
                valueDraft: null,
                isCreateDialogOpen: false,
                createDraft: null,
                pendingKeySwitch: null,
                pendingRefreshDiscard: null,
                pendingDeleteTarget: null,
            });
            setDeleteTargetForConfirm(deleteTarget);
        }
    }, [
        patchKeyValueState,
        pendingDeleteTarget,
        pendingKeySwitch,
        pendingRefreshDiscard,
        performRefresh,
        setDeleteTargetForConfirm,
        tabId,
    ]);

    const handleDeleteDialogOpenChange = useCallback(
        (open: boolean) => {
            if (open || isDeletePending) return;
            setDeleteTargetForConfirm(null);
        },
        [isDeletePending, setDeleteTargetForConfirm],
    );

    const handleConfirmDelete = useCallback(async () => {
        if (!deleteTargetForConfirm) return;

        const target = deleteTargetForConfirm;
        try {
            const result =
                target.kind === "key"
                    ? await deleteKeyMutation.mutateAsync({
                          dbIndex,
                          key: target.key,
                          expectedFingerprint: target.expectedFingerprint ?? "",
                      })
                    : await deleteKeyPrefixMutation.mutateAsync({
                          dbIndex,
                          pattern: target.pattern,
                      });

            const shouldClearActiveKey =
                resolvedKey != null &&
                (target.kind === "key"
                    ? target.key === resolvedKey
                    : resolvedKey.startsWith(target.prefix));

            patchKeyValueState(tabId, {
                activeKey: shouldClearActiveKey ? null : activeKey,
                isPreviewCollapsed: shouldClearActiveKey
                    ? true
                    : isPreviewCollapsed,
                stringPreviewMode: shouldClearActiveKey ? null : stringPreviewMode,
                valueDraft: shouldClearActiveKey ? null : valueDraft,
                pendingDeleteTarget: null,
            });
            setDeleteTargetForConfirm(null);
            await invalidateRedisQueries();
            refreshExplorerDbCounts();
            toast.success(`已删除 ${result.deletedCount} 个 key`);
        } catch (error) {
            console.error("Failed to delete Redis key", error);
        }
    }, [
        activeKey,
        dbIndex,
        deleteKeyMutation,
        deleteKeyPrefixMutation,
        deleteTargetForConfirm,
        invalidateRedisQueries,
        isPreviewCollapsed,
        patchKeyValueState,
        refreshExplorerDbCounts,
        resolvedKey,
        setDeleteTargetForConfirm,
        stringPreviewMode,
        tabId,
        valueDraft,
    ]);

    const handleDeleteCurrentKey = useCallback(() => {
        if (!resolvedKey) return;
        requestDeleteTarget({
            kind: "key",
            key: resolvedKey,
            label: resolvedKey,
            expectedFingerprint:
                valueDraft?.baselineFingerprint ?? detailFingerprint ?? undefined,
        });
    }, [detailFingerprint, requestDeleteTarget, resolvedKey, valueDraft]);

    return {
        isMutating,
        isDeletePending,
        canSaveValue,
        canSaveCreateKey,
        isCreatePending: createKeyValueMutation.isPending,
        isTtlPending: setKeyTtlMutation.isPending,
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
    };
}
