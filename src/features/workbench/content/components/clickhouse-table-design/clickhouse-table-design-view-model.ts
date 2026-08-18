import type { ClickHouseTableDesignViewModel } from "@/types/clickhouse-table-design";
import type { SchemaDesignRuntimeState } from "@/store";
import type { ClickHouseTableSchema } from "@/types/ipc";

const SECTION_LABELS = {
    columns: "Columns",
    engine_keys: "Engine & Keys",
    ttl_settings: "TTL & Settings",
    projections: "Projections",
    skipping_indexes: "Data-skipping Indexes",
} as const;

function buildEngineLabel(schema: ClickHouseTableSchema): string {
    const rawExpression = schema.engine.rawExpression.trim();
    if (rawExpression) return rawExpression;

    return schema.engine.arguments.length > 0
        ? `${schema.engine.family}(${schema.engine.arguments.join(", ")})`
        : schema.engine.family;
}

export function buildClickHouseTableDesignViewModel(
    schema: ClickHouseTableSchema,
): ClickHouseTableDesignViewModel {
    return {
        title: `${schema.identity.database}.${schema.identity.name}`,
        engineLabel: buildEngineLabel(schema),
        engine: schema.engine,
        columns: [...schema.columns],
        keys: schema.keys,
        tableTtl: schema.tableTtl,
        comment: schema.comment,
        settings: [...schema.settings],
        projections: [...schema.projections],
        skippingIndexes: [...schema.skippingIndexes],
        backendEditability: schema.editability.mode,
        blockers: [...schema.editability.blockers],
        sections: [
            {
                id: "columns",
                label: SECTION_LABELS.columns,
                itemCount: schema.columns.length,
            },
            {
                id: "engine_keys",
                label: SECTION_LABELS.engine_keys,
                itemCount: 1,
            },
            {
                id: "ttl_settings",
                label: SECTION_LABELS.ttl_settings,
                itemCount: schema.settings.length + (schema.tableTtl ? 1 : 0),
            },
            {
                id: "projections",
                label: SECTION_LABELS.projections,
                itemCount: schema.projections.length,
            },
            {
                id: "skipping_indexes",
                label: SECTION_LABELS.skipping_indexes,
                itemCount: schema.skippingIndexes.length,
            },
        ],
        readOnly: true,
        revisionHash: schema.baseline.revisionHash,
    };
}

export function buildSchemaDesignRuntimeState(
    schema: ClickHouseTableSchema | null | undefined,
    errorMessage: string | null,
    isFetching = false,
): SchemaDesignRuntimeState {
    if (errorMessage) {
        return {
            mode: "edit",
            loadState: "error",
            operationState: "idle",
            blockerCount: 0,
            errorMessage,
            isDirty: false,
        };
    }

    if (isFetching || !schema) {
        return {
            mode: "edit",
            loadState: "loading",
            operationState: "idle",
            blockerCount: 0,
            errorMessage: null,
            isDirty: false,
        };
    }

    return {
        mode: "edit",
        loadState:
            schema.editability.mode === "editable"
                ? "ready"
                : schema.editability.mode,
        operationState: "idle",
        blockerCount: schema.editability.blockers.length,
        errorMessage: null,
        isDirty: false,
    };
}
