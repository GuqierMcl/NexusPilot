import type { QueryClient } from "@tanstack/react-query";
import type { ContainerRef, CreateTableInput, TableColumnRename, TableSchema } from "@/types/ipc";
import type { TableColumnDraft, TableConstraintDraft, TableIndexDraft, TableSchemaDraft } from "@/types/table-design";
import { apiInvoke } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import {
    MYSQL_COLUMN_TYPE_OPTIONS,
    POSTGRES_COLUMN_TYPE_OPTIONS,
    ORACLE_COLUMN_TYPE_OPTIONS,
    GENERIC_COLUMN_TYPE_OPTIONS,
} from "./table-design-constants";
import { formatColumnType } from "./columns/column-type-format";
import { parseColumnType } from "./columns/column-type-parser";
import {
    tableDesignProfileForDriver,
    type TableDesignDriverProfile,
} from "./driver-profiles";

export function createId(prefix: string): string {
    const suffix =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}::${suffix}`;
}

export function createColumnDraft(
    profile = tableDesignProfileForDriver(null),
): TableColumnDraft {
    const typeDraft = { ...profile.defaults.columnType };

    return {
        id: createId("column"),
        name: "",
        typeName: formatColumnType(typeDraft, profile),
        typeDraft,
        nullable: true,
        defaultValue: "",
        isPrimaryKey: false,
        isUnique: false,
        isIdentity: false,
        identityGeneration: profile.defaults.identityGeneration,
        identityStart: "",
        identityIncrement: "",
        identityMinValue: "",
        identityMaxValue: "",
        identityCache: "",
        identityCycle: false,
        generatedExpression: "",
        generatedStorage: "stored",
        charset: "",
        collation: "",
        comment: "",
    };
}

export function createIndexDraft(): TableIndexDraft {
    return {
        id: createId("index"),
        name: "",
        columns: "",
        isUnique: false,
        method: "btree",
        comment: "",
    };
}

export function createConstraintDraft(): TableConstraintDraft {
    return {
        id: createId("constraint"),
        name: "",
        kind: "unique",
        columns: "",
        reference: "",
        expression: "",
        referenceSchema: "",
        referenceTable: "",
        referenceColumns: "",
        onUpdate: "",
        onDelete: "",
        enforced: true,
        comment: "",
    };
}

export function typeOptionsForDriver(driver?: string | null): string[] {
    if (driver === "mysql") return MYSQL_COLUMN_TYPE_OPTIONS;
    if (driver === "postgres") return POSTGRES_COLUMN_TYPE_OPTIONS;
    if (driver === "oracle") return ORACLE_COLUMN_TYPE_OPTIONS;
    return GENERIC_COLUMN_TYPE_OPTIONS;
}

export interface TableDesignResolvedContext {
    databaseName: string;
    schemaName: string;
    tableName: string;
    driver?: string | null;
    contextLabel: string;
    schemaDisplay: string;
    isValid: boolean;
    errorMessage: string | null;
}

export function resolveTableDesignContext({
    mode,
    container,
    parentContainer,
    draft,
    driver,
}: {
    mode: "create" | "edit";
    container?: ContainerRef | null;
    parentContainer?: ContainerRef | null;
    draft: TableSchemaDraft;
    driver?: string | null;
}): TableDesignResolvedContext {
    const contextContainer = mode === "edit" ? container ?? null : parentContainer ?? container ?? null;
    const databaseName = contextContainer?.database?.trim() ?? "";
    const schemaName = contextContainer?.schema?.trim() ?? "";
    const tableName =
        mode === "edit"
            ? container?.table?.trim() ?? container?.objectName?.trim() ?? draft.basics.tableName.trim()
            : draft.basics.tableName.trim();
    const schemaRequired = driver === "postgres" || driver === "oracle";
    const contextLabel = [databaseName, schemaName].filter(Boolean).join(".") || "目标未确定";
    const schemaDisplay = schemaName || (schemaRequired ? "未指定" : "不适用");
    let errorMessage: string | null = null;

    if (!databaseName) {
        errorMessage =
            mode === "edit"
                ? "当前表缺少数据库上下文，请刷新资源树后重新打开设计器。"
                : "新建表目标缺少数据库上下文，请从数据库、Schema 或 Tables 节点打开新建表。";
    } else if (schemaRequired && !schemaName) {
        errorMessage = "当前数据库新建或修改表需要固定 Schema，请从 Schema 或其 Tables 节点打开。";
    } else if (mode === "edit" && !tableName) {
        errorMessage = "当前表缺少表名上下文，请刷新资源树后重新打开设计器。";
    }

    return {
        databaseName,
        schemaName,
        tableName,
        driver,
        contextLabel,
        schemaDisplay,
        isValid: errorMessage == null,
        errorMessage,
    };
}

export function buildInitialDraft({
    mode,
    container,
    parentContainer,
}: {
    mode: "create" | "edit";
    container?: ContainerRef | null;
    parentContainer?: ContainerRef | null;
}): TableSchemaDraft {
    const contextContainer = container ?? parentContainer ?? null;
    const databaseName = contextContainer?.database ?? "";
    const schemaName = contextContainer?.schema ?? "";
    const tableName =
        mode === "edit"
            ? container?.table ?? container?.objectName ?? ""
            : "";

    return {
        basics: {
            tableName,
            databaseName,
            schemaName,
            engine: "",
            charset: "",
            collation: "",
            comment: "",
            partitionExpression: "",
            partitionRawClause: "",
            partitionReadonlyDescription: "",
        },
        columns: [],
        indexes: [],
        constraints: [],
    };
}

export function toColumnRows(columns: TableColumnDraft[]): unknown[][] {
    return columns.map((column) => [
        column.name,
        column.typeName,
        column.nullable,
        column.defaultValue,
        column.isPrimaryKey,
        column.isUnique,
        column.isIdentity,
        column.comment,
    ]);
}

export function toIndexRows(indexes: TableIndexDraft[]): unknown[][] {
    return indexes.map((index) => [
        index.name,
        index.columns,
        index.isUnique,
        index.method,
        index.comment,
    ]);
}

export function toConstraintRows(constraints: TableConstraintDraft[]): unknown[][] {
    return constraints.map((constraint) => [
        constraint.name,
        constraint.kind,
        constraint.columns,
        constraint.kind === "foreign_key"
            ? [
                  constraint.referenceSchema,
                  constraint.referenceTable,
                  constraint.referenceColumns ? `(${constraint.referenceColumns})` : "",
              ]
                  .filter(Boolean)
                  .join(".")
            : constraint.reference,
        constraint.expression,
        constraint.comment,
    ]);
}

export function isSameDraft(left: TableSchemaDraft, right: TableSchemaDraft): boolean {
    return JSON.stringify(normalizeDraftForComparison(left)) === JSON.stringify(normalizeDraftForComparison(right));
}

function normalizeDraftForComparison(draft: TableSchemaDraft): TableSchemaDraft {
    return {
        ...draft,
        columns: draft.columns.map((column) => ({
            ...column,
            typeDraft: {
                ...column.typeDraft,
                rawTypeName:
                    column.typeDraft.mode === "raw"
                        ? column.typeName.trim()
                        : column.typeDraft.rawTypeName,
            },
        })),
    };
}

export function normalizeColumnDraftType(
    column: TableColumnDraft,
    profile: TableDesignDriverProfile,
): TableColumnDraft {
    const typeDraft = column.typeDraft ?? parseColumnType(column.typeName, profile);

    return {
        ...column,
        typeDraft,
        typeName: formatColumnType(typeDraft, profile),
    };
}

export function tableSchemaToDraft(schema: TableSchema, driver?: string | null): TableSchemaDraft {
    const profile = tableDesignProfileForDriver(driver);

    return {
        basics: {
            tableName: schema.basics.tableName,
            databaseName: schema.basics.databaseName,
            schemaName: schema.basics.schemaName,
            engine: schema.basics.engine ?? "",
            charset: schema.basics.charset ?? "",
            collation: schema.basics.collation ?? "",
            comment: schema.basics.comment ?? "",
            partitionExpression: schema.basics.partition?.expression ?? "",
            partitionRawClause: schema.basics.partition?.rawClause ?? "",
            partitionReadonlyDescription: schema.basics.partition?.readonlyDescription ?? "",
        },
        columns: schema.columns.map((column) => {
            const typeDraft = parseColumnType(column.typeName, profile);

            return {
                id: createId("column"),
                originalName: column.name,
                name: column.name,
                typeName: formatColumnType(typeDraft, profile),
                typeDraft,
                nullable: column.nullable,
                defaultValue: column.defaultValue ?? "",
                isPrimaryKey: column.isPrimaryKey,
                isUnique: column.isUnique,
                isIdentity: column.isIdentity,
                identityGeneration: column.identity?.generation ?? profile.defaults.identityGeneration,
                identityStart: column.identity?.start ?? "",
                identityIncrement: column.identity?.increment ?? "",
                identityMinValue: column.identity?.minValue ?? "",
                identityMaxValue: column.identity?.maxValue ?? "",
                identityCache: column.identity?.cache ?? "",
                identityCycle: column.identity?.cycle ?? false,
                generatedExpression: column.generated?.expression ?? "",
                generatedStorage: column.generated?.storage ?? "stored",
                charset: column.charset ?? "",
                collation: column.collation ?? "",
                comment: column.comment ?? "",
            };
        }),
        indexes: schema.indexes.map((index) => ({
            id: createId("index"),
            name: index.name,
            columns: index.columns.join(", "),
            isUnique: index.isUnique,
            method: index.method ?? "",
            comment: index.comment ?? "",
        })),
        constraints: schema.constraints.map((constraint) => ({
            id: createId("constraint"),
            name: constraint.name,
            kind: constraint.kind,
            columns: constraint.columns.join(", "),
            reference: constraint.reference ?? "",
            expression: constraint.expression ?? "",
            referenceSchema:
                constraint.foreignKey?.schemaName ?? constraint.foreignKey?.databaseName ?? "",
            referenceTable: constraint.foreignKey?.tableName ?? "",
            referenceColumns: constraint.foreignKey?.columns.join(", ") ?? "",
            onUpdate: constraint.foreignKey?.onUpdate ?? "",
            onDelete: constraint.foreignKey?.onDelete ?? "",
            enforced: constraint.enforced ?? true,
            comment: constraint.comment ?? "",
        })),
    };
}

export function nullableText(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function splitColumnList(value: string): string[] {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

export function joinColumnList(columns: string[]): string {
    return columns.join(", ");
}

export function replaceColumnNameInColumnList(value: string, oldName: string, newName: string): string {
    const normalizedOldName = oldName.trim();
    const normalizedNewName = newName.trim();
    if (!normalizedOldName || !normalizedNewName || normalizedOldName === normalizedNewName) {
        return value;
    }

    const columns = splitColumnList(value);
    if (!columns.includes(normalizedOldName)) return value;

    return joinColumnList(
        columns.map((column) => (column === normalizedOldName ? normalizedNewName : column)),
    );
}

export function syncPrimaryKeyConstraintFromColumns(
    constraints: TableConstraintDraft[],
    columns: TableColumnDraft[],
): TableConstraintDraft[] {
    const primaryKeyColumns = columns
        .filter((column) => column.isPrimaryKey)
        .map((column) => column.name.trim())
        .filter(Boolean);
    let primaryKeyHandled = false;

    const nextConstraints = constraints.flatMap((constraint) => {
        if (constraint.kind !== "primary_key") return [constraint];
        if (primaryKeyHandled) return [];

        primaryKeyHandled = true;
        if (primaryKeyColumns.length === 0) return [];

        return [
            {
                ...constraint,
                columns: joinColumnList(primaryKeyColumns),
            },
        ];
    });

    if (!primaryKeyHandled && primaryKeyColumns.length > 0) {
        nextConstraints.push({
            id: createId("constraint"),
            name: "",
            kind: "primary_key",
            columns: joinColumnList(primaryKeyColumns),
            reference: "",
            expression: "",
            referenceSchema: "",
            referenceTable: "",
            referenceColumns: "",
            onUpdate: "",
            onDelete: "",
            enforced: true,
            comment: "",
        });
    }

    return nextConstraints;
}

export function tableSchemaDraftToTableSchema(
    draft: TableSchemaDraft,
    context?: TableDesignResolvedContext,
): TableSchema {
    const isOracle = context?.driver === "oracle";
    return {
        basics: {
            tableName: context?.tableName ?? draft.basics.tableName.trim(),
            databaseName: context?.databaseName ?? draft.basics.databaseName.trim(),
            schemaName: context?.schemaName ?? draft.basics.schemaName.trim(),
            engine: isOracle ? null : nullableText(draft.basics.engine),
            charset: isOracle ? null : nullableText(draft.basics.charset),
            collation: isOracle ? null : nullableText(draft.basics.collation),
            comment: nullableText(draft.basics.comment),
            partition:
                nullableText(draft.basics.partitionExpression) ||
                nullableText(draft.basics.partitionRawClause) ||
                nullableText(draft.basics.partitionReadonlyDescription)
                    ? {
                          expression: nullableText(draft.basics.partitionExpression),
                          rawClause: nullableText(draft.basics.partitionRawClause),
                          readonlyDescription: nullableText(
                              draft.basics.partitionReadonlyDescription,
                          ),
                      }
                    : null,
        },
        columns: draft.columns.map((column) => ({
            name: column.name.trim(),
            typeName: column.typeName.trim(),
            nullable: column.nullable,
            defaultValue: nullableText(column.defaultValue),
            isPrimaryKey: column.isPrimaryKey,
            isUnique: column.isUnique,
            isIdentity: column.isIdentity,
            identity: column.isIdentity
                ? {
                      generation: column.identityGeneration,
                      start: nullableText(column.identityStart),
                      increment: nullableText(column.identityIncrement),
                      minValue: nullableText(column.identityMinValue),
                      maxValue: nullableText(column.identityMaxValue),
                      cache: nullableText(column.identityCache),
                      cycle: column.identityCycle,
                  }
                : null,
            generated: nullableText(column.generatedExpression)
                ? {
                      expression: column.generatedExpression.trim(),
                      storage: isOracle ? "virtual" : column.generatedStorage,
                  }
                : null,
            charset: isOracle ? null : nullableText(column.charset),
            collation: isOracle ? null : nullableText(column.collation),
            comment: nullableText(column.comment),
        })),
        indexes: draft.indexes.map((index) => ({
            name: index.name.trim(),
            columns: splitColumnList(index.columns),
            isUnique: index.isUnique,
            method: isOracle ? null : nullableText(index.method),
            comment: isOracle ? null : nullableText(index.comment),
        })),
        constraints: draft.constraints.map((constraint) => ({
            name: constraint.name.trim(),
            kind: constraint.kind,
            columns: splitColumnList(constraint.columns),
            reference: nullableText(constraint.reference),
            expression: nullableText(constraint.expression),
            foreignKey:
                constraint.kind === "foreign_key" && nullableText(constraint.referenceTable)
                    ? {
                          databaseName:
                              context?.driver === "mysql"
                                  ? nullableText(constraint.referenceSchema)
                                  : null,
                          schemaName:
                              context?.driver === "postgres" || context?.driver === "oracle"
                                  ? nullableText(constraint.referenceSchema)
                                  : null,
                          tableName: constraint.referenceTable.trim(),
                          columns: splitColumnList(constraint.referenceColumns),
                          onUpdate: constraint.onUpdate || null,
                          onDelete: constraint.onDelete || null,
                      }
                    : null,
            enforced: constraint.kind === "check" || constraint.kind === "foreign_key"
                ? constraint.enforced
                : null,
            comment: nullableText(constraint.comment),
        })),
    };
}

export function tableSchemaDraftToCreateTableInput(
    draft: TableSchemaDraft,
    context: TableDesignResolvedContext,
): CreateTableInput {
    return tableSchemaDraftToTableSchema(draft, context);
}

export function buildColumnRenames(snapshot: TableSchemaDraft, draft: TableSchemaDraft): TableColumnRename[] {
    const snapshotById = new Map(snapshot.columns.map((column) => [column.id, column]));

    return draft.columns
        .map((column) => {
            const oldName = (column.originalName ?? snapshotById.get(column.id)?.name ?? "").trim();
            const newName = column.name.trim();
            if (!oldName || !newName || oldName === newName) return null;
            return { oldName, newName };
        })
        .filter((rename): rename is TableColumnRename => rename != null);
}

export function canPreviewCreateTableDraft(draft: TableSchemaDraft): boolean {
    return (
        draft.basics.tableName.trim().length > 0 &&
        draft.columns.length > 0 &&
        draft.columns.every(
            (column) =>
                column.name.trim().length > 0 &&
                column.typeName.trim().length > 0,
        )
    );
}

export function updateTablePreviewPlaceholder(draft: TableSchemaDraft, isDirty: boolean): string {
    if (!isDirty) {
        return [
            "-- ALTER TABLE preview",
            "-- 当前草稿与已读取结构一致，无需变更。",
            `-- table: ${draft.basics.tableName.trim() || "(unspecified)"}`,
        ].join("\n");
    }

    return [
        "-- ALTER TABLE preview",
        "-- Fill in a table name and at least one complete column to preview SQL.",
        `-- table: ${draft.basics.tableName.trim() || "(unspecified)"}`,
        `-- columns: ${draft.columns.length}`,
    ].join("\n");
}

export function joinSqlStatements(statements: string[]): string {
    return statements
        .map((statement) => {
            const trimmed = statement.trim();
            return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
        })
        .join("\n\n");
}

export function createTablePreviewPlaceholder(draft: TableSchemaDraft): string {
    return [
        "-- CREATE TABLE preview",
        "-- Fill in a table name and at least one complete column to preview SQL.",
        `-- table: ${draft.basics.tableName.trim() || "(unspecified)"}`,
        `-- columns: ${draft.columns.length}`,
    ].join("\n");
}

export function editSchemaLoadingPlaceholder(draft: TableSchemaDraft): string {
    return [
        "-- ALTER TABLE preview",
        "-- Loading current table schema before generating ALTER TABLE SQL.",
        `-- table: ${draft.basics.tableName.trim() || "(unspecified)"}`,
    ].join("\n");
}

export async function fetchFreshTableSchema(
    queryClient: QueryClient,
    profileId: string,
    tabRuntimeId: string,
    container: ContainerRef,
): Promise<TableSchema> {
    return queryClient.fetchQuery<TableSchema>({
        queryKey: queryKeys.tableDesign(profileId, tabRuntimeId, container),
        queryFn: () =>
            apiInvoke<TableSchema>(
                "describe_table",
                { profileId, container },
                { silent: true },
            ),
        staleTime: 0,
    });
}
