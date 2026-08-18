import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import {
    useCreateTable,
    useUpdateTable,
} from "@/hooks/queries/use-db-metadata";
import { formatIpcError } from "@/lib/ipc-error";
import { queryKeys } from "@/lib/query-keys";
import {
    useTabRuntimeStateStore,
    useWorkbenchTabsStore,
} from "@/store";
import type { ContainerRef, CreateTableInput, UpdateTableInput } from "@/types/ipc";
import type { TableSchemaDraft } from "@/types/table-design";

import {
    fetchFreshTableSchema,
    tableSchemaToDraft,
} from "./table-design-utils";
import type { TableDesignDriverProfile } from "./driver-profiles";

type PatchTableDesignState = ReturnType<
    typeof useTabRuntimeStateStore.getState
>["patchTableDesignState"];
type SetDirty = ReturnType<typeof useWorkbenchTabsStore.getState>["setDirty"];
type RetargetTableDesignTabToEdit = ReturnType<
    typeof useWorkbenchTabsStore.getState
>["retargetTableDesignTabToEdit"];

interface UseTableDesignSaveOptions {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    mode: "create" | "edit";
    driverProfile: TableDesignDriverProfile;
    container?: ContainerRef | null;
    draft: TableSchemaDraft;
    createTableInput: CreateTableInput;
    updateTableInput: UpdateTableInput | null;
    hasDestructivePreview: boolean;
    isDesignDirty: boolean;
    patchTableDesignState: PatchTableDesignState;
    setDirty: SetDirty;
    retargetTableDesignTabToEdit: RetargetTableDesignTabToEdit;
    setHydratedSchemaKey: Dispatch<SetStateAction<string | null>>;
}

export function useTableDesignSave({
    tabId,
    profileId,
    tabRuntimeId,
    mode,
    driverProfile,
    container,
    draft,
    createTableInput,
    updateTableInput,
    hasDestructivePreview,
    isDesignDirty,
    patchTableDesignState,
    setDirty,
    retargetTableDesignTabToEdit,
    setHydratedSchemaKey,
}: UseTableDesignSaveOptions) {
    const queryClient = useQueryClient();
    const createTable = useCreateTable(profileId);
    const updateTable = useUpdateTable(profileId);
    const [isRefreshingTableSchema, setIsRefreshingTableSchema] = useState(false);
    const [isDestructiveConfirmOpen, setIsDestructiveConfirmOpen] = useState(false);
    const [isRefreshConfirmOpen, setIsRefreshConfirmOpen] = useState(false);

    const saveUpdateTable = useCallback(
        async (confirmDestructive: boolean) => {
            if (updateTableInput == null) return;

            const input: UpdateTableInput = {
                ...updateTableInput,
                confirmDestructive,
            };
            const result = await updateTable.mutateAsync(input);
            let refreshedSchema = false;
            setIsRefreshingTableSchema(true);
            try {
                const remoteSchema = await fetchFreshTableSchema(
                    queryClient,
                    profileId,
                    tabRuntimeId,
                    result.container,
                );
                const remoteDraft = tableSchemaToDraft(remoteSchema, driverProfile.driver);
                patchTableDesignState(tabId, {
                    draft: remoteDraft,
                    snapshot: remoteDraft,
                });
                setHydratedSchemaKey(JSON.stringify(remoteSchema));
                refreshedSchema = true;
            } catch (schemaError) {
                console.error("Failed to refresh updated table schema", schemaError);
                patchTableDesignState(tabId, {
                    snapshot: draft,
                });
                setHydratedSchemaKey(null);
                toast.warning(`已更新表 ${result.tableName}，但读取最新结构失败，请刷新后再编辑`);
            } finally {
                setIsRefreshingTableSchema(false);
            }
            setDirty(tabId, false);
            void queryClient.invalidateQueries({
                queryKey: queryKeys.tableDesign(profileId, tabRuntimeId, container),
            });
            void queryClient.invalidateQueries({
                queryKey: queryKeys.profile(profileId),
            });
            if (refreshedSchema) {
                toast.success(`已更新表 ${result.tableName}`);
            }
        },
        [
            container,
            draft,
            driverProfile.driver,
            patchTableDesignState,
            profileId,
            queryClient,
            setDirty,
            setHydratedSchemaKey,
            tabRuntimeId,
            tabId,
            updateTable,
            updateTableInput,
        ],
    );

    const handleSaveDesign = useCallback(async () => {
        try {
            if (mode === "create") {
                const result = await createTable.mutateAsync(createTableInput);
                setHydratedSchemaKey(null);
                setDirty(tabId, false);
                retargetTableDesignTabToEdit(tabId, result.container);

                let refreshedSchema = false;
                setIsRefreshingTableSchema(true);
                try {
                    const remoteSchema = await fetchFreshTableSchema(
                        queryClient,
                        profileId,
                        tabRuntimeId,
                        result.container,
                    );
                    const remoteDraft = tableSchemaToDraft(remoteSchema, driverProfile.driver);
                    patchTableDesignState(tabId, {
                        draft: remoteDraft,
                        snapshot: remoteDraft,
                    });
                    setHydratedSchemaKey(JSON.stringify(remoteSchema));
                    refreshedSchema = true;
                } catch (schemaError) {
                    console.error("Failed to refresh created table schema", schemaError);
                    patchTableDesignState(tabId, {
                        snapshot: draft,
                    });
                    toast.warning(`已创建表 ${result.tableName}，但读取最新结构失败，请刷新后再编辑`);
                } finally {
                    setIsRefreshingTableSchema(false);
                }

                void queryClient.invalidateQueries({
                    queryKey: queryKeys.tableDesign(profileId, tabRuntimeId, result.container),
                });
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.profile(profileId),
                });
                if (refreshedSchema) {
                    toast.success(`已创建表 ${result.tableName}`);
                }
                return;
            }

            if (hasDestructivePreview) {
                setIsDestructiveConfirmOpen(true);
                return;
            }

            await saveUpdateTable(false);
        } catch (error) {
            console.error("Failed to save table design", error);
        }
    }, [
        createTable,
        createTableInput,
        draft,
        driverProfile.driver,
        hasDestructivePreview,
        mode,
        patchTableDesignState,
        profileId,
        queryClient,
        retargetTableDesignTabToEdit,
        saveUpdateTable,
        setDirty,
        setHydratedSchemaKey,
        tabRuntimeId,
        tabId,
    ]);

    const handleConfirmDestructiveSave = useCallback(async () => {
        setIsDestructiveConfirmOpen(false);
        try {
            await saveUpdateTable(true);
        } catch (error) {
            console.error("Failed to save destructive table design change", error);
        }
    }, [saveUpdateTable]);

    const refreshTableSchemaFromRemote = useCallback(async () => {
        if (mode !== "edit" || !container) return;

        setIsRefreshingTableSchema(true);
        try {
            const remoteSchema = await fetchFreshTableSchema(
                queryClient,
                profileId,
                tabRuntimeId,
                container,
            );
            const remoteDraft = tableSchemaToDraft(remoteSchema, driverProfile.driver);
            patchTableDesignState(tabId, {
                draft: remoteDraft,
                snapshot: remoteDraft,
            });
            setHydratedSchemaKey(JSON.stringify(remoteSchema));
            setDirty(tabId, false);
            void queryClient.invalidateQueries({
                queryKey: queryKeys.profile(profileId),
            });
            toast.success("已刷新表结构");
        } catch (error) {
            console.error("Failed to refresh table schema", error);
            toast.error(`刷新表结构失败：${formatIpcError(error)}`);
        } finally {
            setIsRefreshingTableSchema(false);
        }
    }, [
        container,
        driverProfile.driver,
        mode,
        patchTableDesignState,
        profileId,
        queryClient,
        setDirty,
        setHydratedSchemaKey,
        tabRuntimeId,
        tabId,
    ]);

    const handleRefreshTableSchema = useCallback(() => {
        if (mode !== "edit") return;
        if (isDesignDirty) {
            setIsRefreshConfirmOpen(true);
            return;
        }

        void refreshTableSchemaFromRemote();
    }, [isDesignDirty, mode, refreshTableSchemaFromRemote]);

    const handleConfirmRefreshTableSchema = useCallback(() => {
        setIsRefreshConfirmOpen(false);
        void refreshTableSchemaFromRemote();
    }, [refreshTableSchemaFromRemote]);

    return {
        createTable,
        updateTable,
        createTablePending: createTable.isPending,
        updateTablePending: updateTable.isPending,
        isRefreshingTableSchema,
        isDestructiveConfirmOpen,
        isRefreshConfirmOpen,
        setIsDestructiveConfirmOpen,
        setIsRefreshConfirmOpen,
        handleSaveDesign,
        handleConfirmDestructiveSave,
        handleRefreshTableSchema,
        handleConfirmRefreshTableSchema,
    };
}
