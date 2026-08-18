import { useCallback, useEffect, useMemo } from "react";
import { CircleX, RefreshCw, TableProperties } from "lucide-react";

import {
    Alert,
    AlertDescription,
    AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useClickHouseTableSchema } from "@/hooks/queries/use-db-metadata";
import { formatIpcError } from "@/lib/ipc-error";
import { supportsSchemaMutation } from "@/lib/schema-mutation-capabilities";
import {
    useConnectionSessionStore,
    useContentToolbarStore,
    useTabRuntimeStateStore,
    useWorkbenchTabsStore,
} from "@/store";
import type { ContainerRef } from "@/types/ipc";

import { ClickHouseEditabilityNotice } from "./ClickHouseEditabilityNotice";
import { ClickHouseSchemaHeader } from "./ClickHouseSchemaHeader";
import { ClickHouseTableEditView } from "./clickhouse-table-edit-view";
import {
    buildClickHouseTableDesignViewModel,
    buildSchemaDesignRuntimeState,
} from "./clickhouse-table-design-view-model";
import { ClickHouseColumnsReadOnly } from "./tabs/ClickHouseColumnsReadOnly";
import { ClickHouseEngineKeysReadOnly } from "./tabs/ClickHouseEngineKeysReadOnly";
import { ClickHouseProjectionsReadOnly } from "./tabs/ClickHouseProjectionsReadOnly";
import { ClickHouseSkippingIndexesReadOnly } from "./tabs/ClickHouseSkippingIndexesReadOnly";
import { ClickHouseTtlSettingsReadOnly } from "./tabs/ClickHouseTtlSettingsReadOnly";

interface ClickHouseTableDesignViewProps {
    tabId: string;
    profileId: string;
    tabRuntimeId: string;
    container: ContainerRef;
    isActive: boolean;
}

function ClickHouseTableDesignLoading() {
    return (
        <div className="flex flex-1 flex-col gap-4 p-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="min-h-48 w-full flex-1" />
        </div>
    );
}

interface ClickHouseTableDesignErrorProps {
    message: string;
    isRefreshing: boolean;
    onRetry: () => void;
}

function ClickHouseTableDesignError({
    message,
    isRefreshing,
    onRetry,
}: ClickHouseTableDesignErrorProps) {
    return (
        <div className="flex flex-1 items-start justify-center p-6">
            <Alert variant="destructive" className="max-w-2xl">
                <CircleX />
                <AlertTitle>ClickHouse 表结构读取失败</AlertTitle>
                <AlertDescription>
                    <div className="flex flex-col items-start gap-3">
                        <p>{message}</p>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isRefreshing}
                            onClick={onRetry}
                        >
                            重新读取
                        </Button>
                    </div>
                </AlertDescription>
            </Alert>
        </div>
    );
}

export function ClickHouseTableDesignView({
    tabId,
    profileId,
    tabRuntimeId,
    container,
    isActive,
}: ClickHouseTableDesignViewProps) {
    const getOrCreateSchemaDesignState = useTabRuntimeStateStore(
        (state) => state.getOrCreateSchemaDesignState,
    );
    const patchSchemaDesignState = useTabRuntimeStateStore(
        (state) => state.patchSchemaDesignState,
    );
    const setExecuting = useWorkbenchTabsStore((state) => state.setExecuting);
    const setToolbar = useContentToolbarStore((state) => state.setToolbar);
    const clearToolbar = useContentToolbarStore((state) => state.clearToolbar);
    const capabilities = useConnectionSessionStore(
        (state) => state.sessions[profileId]?.capabilities,
    );
    const schemaQuery = useClickHouseTableSchema(
        profileId,
        tabRuntimeId,
        container,
        isActive,
    );
    const errorMessage = schemaQuery.isError
        ? formatIpcError(schemaQuery.error)
        : null;
    const runtimeState = useMemo(
        () =>
            buildSchemaDesignRuntimeState(
                schemaQuery.data,
                errorMessage,
                schemaQuery.isFetching,
            ),
        [errorMessage, schemaQuery.data, schemaQuery.isFetching],
    );
    const model = useMemo(
        () =>
            schemaQuery.data
                ? buildClickHouseTableDesignViewModel(schemaQuery.data)
                : null,
        [schemaQuery.data],
    );
    const canEditTableStructure = supportsSchemaMutation(
        capabilities,
        "table",
        "alter",
    );
    const canEditTableObjects =
        supportsSchemaMutation(capabilities, "projection", "create") ||
        supportsSchemaMutation(capabilities, "projection", "drop") ||
        supportsSchemaMutation(capabilities, "projection", "clear") ||
        supportsSchemaMutation(capabilities, "projection", "materialize") ||
        supportsSchemaMutation(capabilities, "index", "create") ||
        supportsSchemaMutation(capabilities, "index", "drop") ||
        supportsSchemaMutation(capabilities, "index", "clear") ||
        supportsSchemaMutation(capabilities, "index", "materialize");
    const canEdit =
        schemaQuery.data?.editability.mode === "editable" &&
        schemaQuery.data.editability.blockers.length === 0 &&
        (canEditTableStructure || canEditTableObjects);
    const handleRefresh = useCallback(async () => {
        const result = await schemaQuery.refetch();
        return result.isSuccess ? result.data : undefined;
    }, [schemaQuery]);

    useEffect(() => {
        getOrCreateSchemaDesignState(tabId, runtimeState);
        return () => {
            setExecuting(tabId, false);
        };
    }, [getOrCreateSchemaDesignState, setExecuting, tabId]);

    useEffect(() => {
        if (!isActive || canEdit) return;
        patchSchemaDesignState(tabId, runtimeState);
    }, [canEdit, isActive, patchSchemaDesignState, runtimeState, tabId]);

    useEffect(() => {
        setExecuting(tabId, schemaQuery.isFetching);
    }, [schemaQuery.isFetching, setExecuting, tabId]);

    useEffect(() => {
        if (canEdit) {
            clearToolbar(tabId);
            return;
        }
        setToolbar(tabId, {
            actions: [
                {
                    id: "refresh",
                    icon: RefreshCw,
                    label: "刷新结构",
                    title: "重新读取远端 ClickHouse 表结构",
                    disabled: schemaQuery.isFetching,
                    onClick: handleRefresh,
                },
            ],
            context: {
                icon: TableProperties,
                label: model?.title ?? container.table ?? "ClickHouse 表结构",
            },
        });
        return () => clearToolbar(tabId);
    }, [
        clearToolbar,
        canEdit,
        container.table,
        handleRefresh,
        model?.title,
        schemaQuery.isFetching,
        setToolbar,
        tabId,
    ]);

    if (schemaQuery.isError && !schemaQuery.data) {
        return (
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <ClickHouseTableDesignError
                    message={errorMessage ?? "未知错误"}
                    isRefreshing={schemaQuery.isFetching}
                    onRetry={handleRefresh}
                />
            </div>
        );
    }

    if (!model) {
        return (
            <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <ClickHouseTableDesignLoading />
            </div>
        );
    }

    if (canEdit && schemaQuery.data) {
        return (
            <ClickHouseTableEditView
                tabId={tabId}
                profileId={profileId}
                tabRuntimeId={tabRuntimeId}
                container={container}
                schema={schemaQuery.data}
                isActive={isActive}
                onRefresh={handleRefresh}
            />
        );
    }

    return (
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <ClickHouseSchemaHeader
                model={model}
                isRefreshing={schemaQuery.isFetching}
                onRefresh={handleRefresh}
            />
            <div className="shrink-0 px-3 py-2">
                <ClickHouseEditabilityNotice model={model} />
            </div>
            <Tabs
                defaultValue="columns"
                className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden"
            >
                <div className="min-w-0 shrink-0 overflow-x-auto border-b px-3 py-1">
                    <TabsList className="h-7 min-w-max" variant="line">
                        {model.sections.map((section) => (
                            <TabsTrigger
                                key={section.id}
                                value={section.id}
                                className="text-xs"
                            >
                                {section.label}
                                <span className="text-muted-foreground">
                                    {section.itemCount}
                                </span>
                            </TabsTrigger>
                        ))}
                    </TabsList>
                </div>
                <TabsContent value="columns" className="min-h-0 flex-1 p-0">
                    <ScrollArea className="h-full">
                        <div className="p-3">
                            <ClickHouseColumnsReadOnly columns={model.columns} />
                        </div>
                    </ScrollArea>
                </TabsContent>
                <TabsContent value="engine_keys" className="min-h-0 flex-1 p-0">
                    <ScrollArea className="h-full">
                        <div className="p-3">
                            <ClickHouseEngineKeysReadOnly model={model} />
                        </div>
                    </ScrollArea>
                </TabsContent>
                <TabsContent value="ttl_settings" className="min-h-0 flex-1 p-0">
                    <ScrollArea className="h-full">
                        <div className="p-3">
                            <ClickHouseTtlSettingsReadOnly model={model} />
                        </div>
                    </ScrollArea>
                </TabsContent>
                <TabsContent value="projections" className="min-h-0 flex-1 p-0">
                    <ScrollArea className="h-full">
                        <div className="p-3">
                            <ClickHouseProjectionsReadOnly
                                projections={model.projections}
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
                            <ClickHouseSkippingIndexesReadOnly
                                indexes={model.skippingIndexes}
                            />
                        </div>
                    </ScrollArea>
                </TabsContent>
            </Tabs>
        </div>
    );
}
