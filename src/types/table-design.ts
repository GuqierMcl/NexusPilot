import type { ColumnTypeDraft } from "@/features/workbench/content/components/table-design/columns/column-type-model";

export type TableDesignMode = "create" | "edit";

export type TableConstraintDraftKind =
    | "primary_key"
    | "unique"
    | "foreign_key"
    | "check";

export interface TableDesignBasicsDraft {
    tableName: string;
    databaseName: string;
    schemaName: string;
    engine: string;
    charset: string;
    collation: string;
    comment: string;
    partitionExpression: string;
    partitionRawClause: string;
    partitionReadonlyDescription: string;
}

export interface TableColumnDraft {
    id: string;
    originalName?: string;
    name: string;
    typeName: string;
    typeDraft: ColumnTypeDraft;
    nullable: boolean;
    defaultValue: string;
    isPrimaryKey: boolean;
    isUnique: boolean;
    isIdentity: boolean;
    identityGeneration: "always" | "by_default";
    identityStart: string;
    identityIncrement: string;
    identityMinValue: string;
    identityMaxValue: string;
    identityCache: string;
    identityCycle: boolean;
    generatedExpression: string;
    generatedStorage: "virtual" | "stored";
    charset: string;
    collation: string;
    comment: string;
}

export interface TableIndexDraft {
    id: string;
    name: string;
    columns: string;
    isUnique: boolean;
    method: string;
    comment: string;
}

export interface TableConstraintDraft {
    id: string;
    name: string;
    kind: TableConstraintDraftKind;
    columns: string;
    reference: string;
    expression: string;
    referenceSchema: string;
    referenceTable: string;
    referenceColumns: string;
    onUpdate: "" | "no_action" | "restrict" | "cascade" | "set_null" | "set_default";
    onDelete: "" | "no_action" | "restrict" | "cascade" | "set_null" | "set_default";
    enforced: boolean;
    comment: string;
}

export interface TableSchemaDraft {
    basics: TableDesignBasicsDraft;
    columns: TableColumnDraft[];
    indexes: TableIndexDraft[];
    constraints: TableConstraintDraft[];
}
