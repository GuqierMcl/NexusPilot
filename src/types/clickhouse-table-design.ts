import type {
    ClickHouseColumnDefaultKind,
    ClickHouseColumnSchema,
    ClickHouseEngineSchema,
    ClickHouseKeySchema,
    ClickHouseProjectionSchema,
    ClickHouseSchemaBlocker,
    ClickHouseSchemaEditabilityMode,
    ClickHouseSettingSchema,
    ClickHouseSkippingIndexSchema,
    ClickHouseTableSchema,
} from "@/types/ipc";

export interface ClickHouseCodecDraft {
    id: string;
    name: string;
    arguments: string[];
}

export interface ClickHouseColumnCreateDraft {
    id: string;
    name: string;
    typeName: string;
    defaultKind: ClickHouseColumnDefaultKind;
    defaultExpression: string;
    codecs: ClickHouseCodecDraft[];
    ttlExpression: string;
    comment: string;
}

export interface ClickHouseTableCreateSettingDraft {
    id: string;
    name: string;
    value: string;
}

export interface ClickHouseTableCreateDraft {
    database: string;
    name: string;
    columns: ClickHouseColumnCreateDraft[];
    engineFamily: string;
    engineArguments: string[];
    orderBy: string;
    partitionBy: string;
    primaryKey: string;
    sampleBy: string;
    tableTtl: string;
    settings: ClickHouseTableCreateSettingDraft[];
    comment: string;
}

export interface ClickHouseTableEditDraft {
    table: ClickHouseTableCreateDraft;
    baseline: ClickHouseTableSchema;
    sourceColumnNameById: Record<string, string | null>;
}

export interface ClickHouseColumnActionDraft {
    action: "clear" | "materialize";
    columnName: string;
}

export interface ClickHouseProjectionCreateDraft {
    name: string;
    query: string;
}

export interface ClickHouseSkippingIndexCreateDraft {
    name: string;
    expression: string;
    indexType:
        | "minmax"
        | "set"
        | "bloom_filter"
        | "ngrambf_v1"
        | "tokenbf_v1";
    typeArguments: string[];
    granularity: string;
}

export type ClickHouseTableObjectActionDraft =
    | {
          objectKind: "projection";
          operation: "create" | "drop" | "clear" | "materialize";
          name: string;
          definition: ClickHouseProjectionCreateDraft | null;
      }
    | {
          objectKind: "index";
          operation: "create" | "drop" | "clear" | "materialize";
          name: string;
          definition: ClickHouseSkippingIndexCreateDraft | null;
      };

export type ClickHouseTableDesignSectionId =
    | "columns"
    | "engine_keys"
    | "ttl_settings"
    | "projections"
    | "skipping_indexes";

export interface ClickHouseTableDesignSection {
    id: ClickHouseTableDesignSectionId;
    label: string;
    itemCount: number;
}

export interface ClickHouseTableDesignViewModel {
    title: string;
    engineLabel: string;
    engine: ClickHouseEngineSchema;
    columns: ClickHouseColumnSchema[];
    keys: ClickHouseKeySchema;
    tableTtl: string | null;
    comment: string | null;
    settings: ClickHouseSettingSchema[];
    projections: ClickHouseProjectionSchema[];
    skippingIndexes: ClickHouseSkippingIndexSchema[];
    backendEditability: ClickHouseSchemaEditabilityMode;
    blockers: ClickHouseSchemaBlocker[];
    sections: ClickHouseTableDesignSection[];
    readOnly: true;
    revisionHash: string;
}
