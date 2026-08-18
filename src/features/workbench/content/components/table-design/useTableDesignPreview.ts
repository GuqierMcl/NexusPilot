import { useEffect, useMemo, useState } from "react";

import {
    usePreviewCreateTable,
    usePreviewUpdateTable,
} from "@/hooks/queries/use-db-metadata";
import type { ContainerRef, UpdateTableInput } from "@/types/ipc";
import type { TableSchemaDraft } from "@/types/table-design";

import {
    buildColumnRenames,
    canPreviewCreateTableDraft,
    createTablePreviewPlaceholder,
    editSchemaLoadingPlaceholder,
    isSameDraft,
    joinSqlStatements,
    tableSchemaDraftToCreateTableInput,
    tableSchemaDraftToTableSchema,
    updateTablePreviewPlaceholder,
    type TableDesignResolvedContext,
} from "./table-design-utils";
import {
    hasValidationErrors,
    type TableDesignValidationIssue,
} from "./validation/table-design-validation";

interface UseTableDesignPreviewOptions {
    profileId: string;
    mode: "create" | "edit";
    container?: ContainerRef | null;
    draft: TableSchemaDraft;
    snapshot: TableSchemaDraft;
    tableDesignContext: TableDesignResolvedContext;
    hydratedSchemaKey: string | null;
    validationIssues: TableDesignValidationIssue[];
}

export function useTableDesignPreview({
    profileId,
    mode,
    container,
    draft,
    snapshot,
    tableDesignContext,
    hydratedSchemaKey,
    validationIssues,
}: UseTableDesignPreviewOptions) {
    const [resolvedUpdatePreviewKey, setResolvedUpdatePreviewKey] = useState<string | null>(null);
    const [resolvedCreatePreviewKey, setResolvedCreatePreviewKey] = useState<string | null>(null);
    const previewCreateTable = usePreviewCreateTable(profileId);
    const previewUpdateTable = usePreviewUpdateTable(profileId);
    const createTableInput = useMemo(
        () => tableSchemaDraftToCreateTableInput(draft, tableDesignContext),
        [draft, tableDesignContext],
    );
    const createTableInputKey = useMemo(
        () => JSON.stringify(createTableInput),
        [createTableInput],
    );
    const canPreviewCreateTable =
        mode === "create" &&
        !hasValidationErrors(validationIssues) &&
        tableDesignContext.isValid &&
        canPreviewCreateTableDraft(draft);
    const isDesignDirty = useMemo(() => !isSameDraft(draft, snapshot), [draft, snapshot]);
    const baselineTableSchema = useMemo(
        () => tableSchemaDraftToTableSchema(snapshot, tableDesignContext),
        [snapshot, tableDesignContext],
    );
    const targetTableSchema = useMemo(
        () => tableSchemaDraftToTableSchema(draft, tableDesignContext),
        [draft, tableDesignContext],
    );
    const columnRenames = useMemo(
        () => buildColumnRenames(snapshot, draft),
        [draft, snapshot],
    );
    const updateTableInput = useMemo<UpdateTableInput | null>(() => {
        if (!container || container.kind !== "table" || !tableDesignContext.isValid) return null;
        return {
            container,
            baseline: baselineTableSchema,
            target: targetTableSchema,
            ...(columnRenames.length > 0 ? { columnRenames } : {}),
        };
    }, [baselineTableSchema, columnRenames, container, tableDesignContext.isValid, targetTableSchema]);
    const updateTableInputKey = useMemo(
        () => (updateTableInput ? JSON.stringify(updateTableInput) : ""),
        [updateTableInput],
    );
    const canPreviewUpdateTable =
        mode === "edit" &&
        !hasValidationErrors(validationIssues) &&
        hydratedSchemaKey != null &&
        isDesignDirty &&
        updateTableInput != null &&
        canPreviewCreateTableDraft(draft);
    const updatePreview = previewUpdateTable.data;
    const hasDestructivePreview =
        mode === "edit" &&
        canPreviewUpdateTable &&
        resolvedUpdatePreviewKey === updateTableInputKey &&
        Boolean(updatePreview?.destructive);
    const updatePreviewWarnings = updatePreview?.warnings ?? [];
    const destructiveWarnings = hasDestructivePreview ? updatePreviewWarnings : [];

    useEffect(() => {
        if (mode !== "create" || !canPreviewCreateTable) {
            setResolvedCreatePreviewKey(null);
            return;
        }

        setResolvedCreatePreviewKey(null);
        const timer = window.setTimeout(() => {
            previewCreateTable.mutate(createTableInput, {
                onSuccess: () => setResolvedCreatePreviewKey(createTableInputKey),
            });
        }, 500);

        return () => window.clearTimeout(timer);
    }, [
        canPreviewCreateTable,
        createTableInput,
        createTableInputKey,
        mode,
    ]);

    useEffect(() => {
        if (mode !== "edit" || !canPreviewUpdateTable || updateTableInput == null) {
            setResolvedUpdatePreviewKey(null);
            return;
        }

        setResolvedUpdatePreviewKey(null);
        const timer = window.setTimeout(() => {
            previewUpdateTable.mutate(updateTableInput, {
                onSuccess: () => setResolvedUpdatePreviewKey(updateTableInputKey),
            });
        }, 500);

        return () => window.clearTimeout(timer);
    }, [
        canPreviewUpdateTable,
        mode,
        updateTableInput,
        updateTableInputKey,
    ]);

    const ddlText = useMemo(() => {
        if (tableDesignContext.errorMessage) {
            return [
                mode === "create" ? "-- CREATE TABLE preview" : "-- ALTER TABLE preview",
                `-- ${tableDesignContext.errorMessage}`,
            ].join("\n");
        }

        if (mode === "create") {
            if (!canPreviewCreateTable) {
                return createTablePreviewPlaceholder(draft);
            }

            if (previewCreateTable.isPending) {
                return "-- Generating CREATE TABLE preview...";
            }

            if (resolvedCreatePreviewKey !== createTableInputKey) {
                return "-- Waiting to generate CREATE TABLE preview...";
            }

            if (previewCreateTable.isError) {
                return "-- Failed to generate CREATE TABLE preview.";
            }

            const statements = previewCreateTable.data?.statements ?? [];
            return statements.length > 0
                ? joinSqlStatements(statements)
                : createTablePreviewPlaceholder(draft);
        }

        if (hydratedSchemaKey == null) {
            return editSchemaLoadingPlaceholder(draft);
        }

        if (!canPreviewUpdateTable) {
            return updateTablePreviewPlaceholder(draft, isDesignDirty);
        }

        if (previewUpdateTable.isPending) {
            return "-- Generating ALTER TABLE preview...";
        }

        if (resolvedUpdatePreviewKey !== updateTableInputKey) {
            return "-- Waiting to generate ALTER TABLE preview...";
        }

        if (previewUpdateTable.isError) {
            return "-- Failed to generate ALTER TABLE preview.";
        }

        const statements = previewUpdateTable.data?.statements ?? [];
        return statements.length > 0
            ? joinSqlStatements(statements)
            : updateTablePreviewPlaceholder(draft, isDesignDirty);
    }, [
        canPreviewCreateTable,
        canPreviewUpdateTable,
        createTableInputKey,
        draft,
        hydratedSchemaKey,
        isDesignDirty,
        mode,
        previewCreateTable.data,
        previewCreateTable.isError,
        previewCreateTable.isPending,
        previewUpdateTable.data,
        previewUpdateTable.isError,
        previewUpdateTable.isPending,
        resolvedCreatePreviewKey,
        resolvedUpdatePreviewKey,
        tableDesignContext.errorMessage,
        updateTableInputKey,
    ]);

    return {
        createTableInput,
        createTableInputKey,
        updateTableInput,
        updateTableInputKey,
        canPreviewCreateTable,
        canPreviewUpdateTable,
        isDesignDirty,
        hasDestructivePreview,
        destructiveWarnings,
        updatePreviewWarnings,
        ddlText,
        previewCreateTable,
        previewUpdateTable,
        resolvedCreatePreviewKey,
        resolvedUpdatePreviewKey,
    };
}
