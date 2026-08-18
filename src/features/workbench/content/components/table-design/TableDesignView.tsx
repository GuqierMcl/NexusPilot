import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";

import {
    useTableSchema,
} from "@/hooks/queries/use-db-metadata";
import { formatIpcError } from "@/lib/ipc-error";
import { useExplorerStore, useTabRuntimeStateStore, useWorkbenchTabsStore } from "@/store";
import type { TableDesignPayload } from "@/types/tab-payloads";

import { TableDesignConfirmDialogs } from "./TableDesignConfirmDialogs";
import { TableDesignDdlDrawer } from "./TableDesignDdlDrawer";
import { TableDesignHeader } from "./TableDesignHeader";
import { TableDesignTabs } from "./TableDesignTabs";
import { tableDesignProfileForDriver } from "./driver-profiles";
import {
    buildColumnColumns,
    buildConstraintColumns,
    buildIndexColumns,
} from "./table-design-grid-columns";
import {
    buildInitialDraft,
    isSameDraft,
    resolveTableDesignContext,
    tableSchemaToDraft,
} from "./table-design-utils";
import { useTableDesignDraftActions } from "./useTableDesignDraftActions";
import { useTableDesignPreview } from "./useTableDesignPreview";
import { useTableDesignSave } from "./useTableDesignSave";
import { useTableDesignToolbar } from "./useTableDesignToolbar";
import { validateTableDesignDraft } from "./validation/table-design-validation";

interface TableDesignViewProps {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    mode: "create" | "edit";
    container?: TableDesignPayload["container"] | null;
    parentContainer?: TableDesignPayload["parentContainer"] | null;
    isActive?: boolean;
}

export function TableDesignView({
    tabId,
    profileId,
    tabRuntimeId,
    mode,
    container,
    parentContainer,
}: TableDesignViewProps) {
    const connection = useExplorerStore(
        (state) => state.connections.find((item) => item.id === profileId) ?? null,
    );
    const driver = connection?.driver ?? null;
    const driverProfile = useMemo(() => tableDesignProfileForDriver(driver), [driver]);
    const runtimeState =
        useTabRuntimeStateStore((state) => state.tableDesignByTabId[tabId]) ?? null;
    const getOrCreateTableDesignState = useTabRuntimeStateStore(
        (state) => state.getOrCreateTableDesignState,
    );
    const patchTableDesignState = useTabRuntimeStateStore(
        (state) => state.patchTableDesignState,
    );
    const resetTableDesignDraft = useTabRuntimeStateStore(
        (state) => state.resetTableDesignDraft,
    );
    const setExecuting = useWorkbenchTabsStore((state) => state.setExecuting);
    const setDirty = useWorkbenchTabsStore((state) => state.setDirty);
    const retargetTableDesignTabToEdit = useWorkbenchTabsStore(
        (state) => state.retargetTableDesignTabToEdit,
    );
    const [hydratedSchemaKey, setHydratedSchemaKey] = useState<string | null>(null);
    const [isDdlDrawerOpen, setIsDdlDrawerOpen] = useState(false);
    const drawerContainerRef = useRef<HTMLDivElement | null>(null);

    const initialDraft = useMemo(
        () => buildInitialDraft({ mode, container, parentContainer }),
        [container, mode, parentContainer, profileId, tabId, tabRuntimeId],
    );

    useEffect(() => {
        getOrCreateTableDesignState(tabId, {
            draft: initialDraft,
            snapshot: initialDraft,
        });
    }, [getOrCreateTableDesignState, initialDraft, tabId]);

    const draft = runtimeState?.draft ?? initialDraft;
    const snapshot = runtimeState?.snapshot ?? initialDraft;
    const tableDesignContext = useMemo(
        () => resolveTableDesignContext({ mode, container, parentContainer, draft, driver }),
        [container, draft, driver, mode, parentContainer],
    );
    const tableSchemaQuery = useTableSchema(
        profileId,
        tabRuntimeId,
        container,
        mode === "edit",
    );
    const isDesignDirty = useMemo(() => !isSameDraft(draft, snapshot), [draft, snapshot]);
    const validationIssues = useMemo(
        () => validateTableDesignDraft(draft, driverProfile, mode),
        [draft, driverProfile, mode],
    );

    const {
        createTableInput,
        createTableInputKey,
        updateTableInput,
        updateTableInputKey,
        canPreviewCreateTable,
        canPreviewUpdateTable,
        hasDestructivePreview,
        destructiveWarnings,
        updatePreviewWarnings,
        ddlText,
        previewCreateTable,
        previewUpdateTable,
        resolvedCreatePreviewKey,
        resolvedUpdatePreviewKey,
    } = useTableDesignPreview({
        profileId,
        mode,
        container,
        draft,
        snapshot,
        tableDesignContext,
        hydratedSchemaKey,
        validationIssues,
    });

    const {
        createTablePending,
        updateTablePending,
        isRefreshingTableSchema,
        isDestructiveConfirmOpen,
        isRefreshConfirmOpen,
        setIsDestructiveConfirmOpen,
        setIsRefreshConfirmOpen,
        handleSaveDesign,
        handleConfirmDestructiveSave,
        handleRefreshTableSchema,
        handleConfirmRefreshTableSchema,
    } = useTableDesignSave({
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
    });
    const {
        updateBasicsField,
        updateColumnDraft,
        updateIndexDraft,
        updateConstraintDraft,
        patchColumnDraft,
        patchIndexDraft,
        patchConstraintDraft,
        handleDeleteColumns,
        handleDeleteIndexes,
        handleDeleteConstraints,
        handleMoveColumns,
        handleMoveIndexes,
        handleMoveConstraints,
        handleAddColumn,
        handleAddIndex,
        handleAddConstraint,
    } = useTableDesignDraftActions({
        tabId,
        profile: driverProfile,
        patchTableDesignState,
        resetTableDesignDraft,
    });

    const canSaveDesign =
        mode === "create"
            ? isDesignDirty &&
              canPreviewCreateTable &&
              resolvedCreatePreviewKey === createTableInputKey &&
              !previewCreateTable.isPending &&
              !previewCreateTable.isError &&
              !createTablePending &&
              !isRefreshingTableSchema &&
              (previewCreateTable.data?.statements.length ?? 0) > 0
            : canPreviewUpdateTable &&
              resolvedUpdatePreviewKey === updateTableInputKey &&
              !previewUpdateTable.isPending &&
              !previewUpdateTable.isError &&
              !updateTablePending &&
              !isRefreshingTableSchema &&
              (previewUpdateTable.data?.statements.length ?? 0) > 0;
    const isExecuting =
        tableSchemaQuery.isFetching ||
        createTablePending ||
        updateTablePending ||
        isRefreshingTableSchema;
    const remoteSchemaKey = useMemo(
        () => (tableSchemaQuery.data ? JSON.stringify(tableSchemaQuery.data) : null),
        [tableSchemaQuery.data],
    );

    useEffect(() => {
        if (!tableSchemaQuery.data || remoteSchemaKey == null) return;
        if (hydratedSchemaKey === remoteSchemaKey) return;

        const currentState =
            useTabRuntimeStateStore.getState().tableDesignByTabId[tabId];
        const currentDraft = currentState?.draft ?? draft;
        const currentSnapshot = currentState?.snapshot ?? snapshot;

        if (hydratedSchemaKey != null && !isSameDraft(currentDraft, currentSnapshot)) {
            return;
        }

        const remoteDraft = tableSchemaToDraft(tableSchemaQuery.data, driverProfile.driver);
        patchTableDesignState(tabId, {
            draft: remoteDraft,
            snapshot: remoteDraft,
        });
        setHydratedSchemaKey(remoteSchemaKey);
    }, [
        draft,
        driverProfile.driver,
        hydratedSchemaKey,
        patchTableDesignState,
        remoteSchemaKey,
        snapshot,
        tabId,
        tableSchemaQuery.data,
    ]);

    useEffect(() => {
        setExecuting(tabId, isExecuting);
    }, [isExecuting, setExecuting, tabId]);

    useEffect(() => {
        setDirty(tabId, isDesignDirty);
    }, [isDesignDirty, setDirty, tabId]);

    const handleOpenDdlPreview = useCallback(() => {
        setIsDdlDrawerOpen(true);
    }, []);

    useTableDesignToolbar({
        tabId,
        mode,
        draft,
        snapshot,
        canSaveDesign,
        isDesignDirty,
        isRefreshingTableSchema,
        isUpdatePending: updateTablePending,
        onSaveDesign: handleSaveDesign,
        onOpenDdlPreview: handleOpenDdlPreview,
        onRefreshTableSchema: handleRefreshTableSchema,
        resetTableDesignDraft,
    });

    const columnColumns = useMemo(() => buildColumnColumns(driver), [driver]);
    const indexColumns = useMemo(() => buildIndexColumns(), []);
    const constraintColumns = useMemo(() => buildConstraintColumns(), []);

    const handleCopyDdl = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(ddlText);
            toast.success("DDL 已复制");
        } catch (error) {
            console.error("Failed to copy table design DDL", error);
            toast.error("复制 DDL 失败");
        }
    }, [ddlText]);

    const handleExportDdl = useCallback(() => {
        const blob = new Blob([ddlText], { type: "text/sql;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${draft.basics.tableName.trim() || "table-design"}.sql`;
        anchor.click();
        URL.revokeObjectURL(url);
    }, [ddlText, draft.basics.tableName]);

    const previewErrorMessage = useMemo(() => {
        if (mode === "create" && previewCreateTable.isError) {
            return formatIpcError(previewCreateTable.error);
        }
        if (mode === "edit" && previewUpdateTable.isError) {
            return formatIpcError(previewUpdateTable.error);
        }
        return null;
    }, [
        mode,
        previewCreateTable.error,
        previewCreateTable.isError,
        previewUpdateTable.error,
        previewUpdateTable.isError,
    ]);

    return (
        <>
        <div
            ref={drawerContainerRef}
            className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
            <TableDesignHeader
                mode={mode}
                driverName={driverProfile.displayName}
                draft={draft}
                context={tableDesignContext}
                isDirty={isDesignDirty}
                hasDestructivePreview={hasDestructivePreview}
                validationIssues={validationIssues}
                isRefreshing={isRefreshingTableSchema}
                onTableNameChange={(value) => updateBasicsField("tableName", value)}
                onRefresh={handleRefreshTableSchema}
            />
            <TableDesignTabs
                mode={mode}
                driver={driver}
                draft={draft}
                profile={driverProfile}
                columnColumns={columnColumns}
                indexColumns={indexColumns}
                constraintColumns={constraintColumns}
                onBasicsFieldChange={updateBasicsField}
                onAddColumn={handleAddColumn}
                onAddIndex={handleAddIndex}
                onAddConstraint={handleAddConstraint}
                onDeleteColumns={handleDeleteColumns}
                onDeleteIndexes={handleDeleteIndexes}
                onDeleteConstraints={handleDeleteConstraints}
                onMoveColumns={handleMoveColumns}
                onMoveIndexes={handleMoveIndexes}
                onMoveConstraints={handleMoveConstraints}
                onUpdateColumn={updateColumnDraft}
                onUpdateIndex={updateIndexDraft}
                onUpdateConstraint={updateConstraintDraft}
                onPatchColumn={patchColumnDraft}
                onPatchIndex={patchIndexDraft}
                onPatchConstraint={patchConstraintDraft}
            />
            <TableDesignDdlDrawer
                isOpen={isDdlDrawerOpen}
                onOpenChange={setIsDdlDrawerOpen}
                containerRef={drawerContainerRef.current}
                mode={mode}
                tableName={draft.basics.tableName}
                ddlText={ddlText}
                validationIssues={validationIssues}
                destructiveWarnings={destructiveWarnings}
                updatePreviewWarnings={updatePreviewWarnings}
                isPreviewPending={previewCreateTable.isPending || previewUpdateTable.isPending}
                previewErrorMessage={previewErrorMessage}
                onCopyDdl={handleCopyDdl}
                onExportDdl={handleExportDdl}
            />
            </div>
        <TableDesignConfirmDialogs
            isDestructiveConfirmOpen={isDestructiveConfirmOpen}
            isRefreshConfirmOpen={isRefreshConfirmOpen}
            destructiveWarnings={destructiveWarnings}
            isUpdatePending={updateTablePending}
            isRefreshingTableSchema={isRefreshingTableSchema}
            onDestructiveConfirmOpenChange={setIsDestructiveConfirmOpen}
            onRefreshConfirmOpenChange={setIsRefreshConfirmOpen}
            onConfirmDestructiveSave={handleConfirmDestructiveSave}
            onConfirmRefreshTableSchema={handleConfirmRefreshTableSchema}
        />
        </>
    );
}
