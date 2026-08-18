import type { ClickHouseTableEditDraft } from "@/types/clickhouse-table-design";
import type {
    ClickHouseAlterTableTarget,
    ClickHouseColumnRenameIntent,
    ClickHouseTableSchema,
} from "@/types/ipc";

import {
    clickHouseDraftToCreateTarget,
    clickHouseSchemaToCreateDraft,
    cloneClickHouseTableCreateDraft,
} from "./clickhouse-table-create-draft";

function cloneEditability<T extends { blockers: { code: string; path: string; message: string }[] }>(
    editability: T,
): T {
    return {
        ...editability,
        blockers: editability.blockers.map((blocker) => ({ ...blocker })),
    };
}

export function cloneClickHouseTableSchema(
    schema: ClickHouseTableSchema,
): ClickHouseTableSchema {
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

export function clickHouseSchemaToEditDraft(
    schema: ClickHouseTableSchema,
): ClickHouseTableEditDraft {
    const table = clickHouseSchemaToCreateDraft(schema);
    const sourceColumnNameById = Object.fromEntries(
        table.columns.map((column, index) => [
            column.id,
            schema.columns[index]?.name ?? null,
        ]),
    );

    return {
        table,
        baseline: cloneClickHouseTableSchema(schema),
        sourceColumnNameById,
    };
}

export function cloneClickHouseTableEditDraft(
    draft: ClickHouseTableEditDraft,
): ClickHouseTableEditDraft {
    const table = cloneClickHouseTableCreateDraft(draft.table);
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

function explicitColumnRenames(
    draft: ClickHouseTableEditDraft,
): ClickHouseColumnRenameIntent[] {
    return draft.table.columns
        .flatMap((column) => {
            const sourceName = draft.sourceColumnNameById[column.id] ?? null;
            return sourceName != null && sourceName !== column.name
                ? [{ from: sourceName, to: column.name }]
                : [];
        })
        .sort(
            (left, right) =>
                left.from.localeCompare(right.from) ||
                left.to.localeCompare(right.to),
        );
}

export function clickHouseEditDraftToAlterTarget(
    draft: ClickHouseTableEditDraft,
): ClickHouseAlterTableTarget {
    return {
        baseline: cloneClickHouseTableSchema(draft.baseline),
        desired: clickHouseDraftToCreateTarget(draft.table),
        columnRenames: explicitColumnRenames(draft),
    };
}

export function clickHouseEditDraftTargetKey(
    draft: ClickHouseTableEditDraft,
): string {
    const target = clickHouseEditDraftToAlterTarget(draft);
    return JSON.stringify({
        desired: target.desired,
        columnRenames: target.columnRenames,
    });
}
