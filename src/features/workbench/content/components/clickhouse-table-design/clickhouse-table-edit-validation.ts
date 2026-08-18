import type {
    ClickHouseColumnActionDraft,
    ClickHouseTableEditDraft,
} from "@/types/clickhouse-table-design";

import {
    clickHouseEditDraftTargetKey,
    clickHouseSchemaToEditDraft,
} from "./clickhouse-table-edit-draft";
import { validateClickHouseTableCreateDraft } from "./clickhouse-table-create-validation";

export interface ClickHouseEditValidationIssue {
    path: string;
    message: string;
}

const SUPPORTED_TYPE_NAMES = new Set([
    "Bool",
    "String",
    "Date",
    "Date32",
    "UUID",
    "IPv4",
    "IPv6",
    "Float32",
    "Float64",
    "FixedString",
    "Decimal",
    "Decimal32",
    "Decimal64",
    "Decimal128",
    "Decimal256",
    "DateTime",
    "DateTime64",
    "Enum8",
    "Enum16",
    "Nullable",
    "LowCardinality",
    "Array",
    "Map",
    "Tuple",
    "Nested",
    "Variant",
    "JSON",
    "Object",
]);

function addIssue(
    issues: ClickHouseEditValidationIssue[],
    path: string,
    message: string,
): void {
    if (!issues.some((issue) => issue.path === path && issue.message === message)) {
        issues.push({ path, message });
    }
}

function isSupportedTypeName(typeName: string): boolean {
    const rootName = /^\s*([A-Za-z_][A-Za-z0-9_]*)/u.exec(typeName)?.[1];
    if (!rootName) return false;
    if (/^(?:U?Int)(?:8|16|32|64|128|256)$/u.test(rootName)) return true;
    return SUPPORTED_TYPE_NAMES.has(rootName);
}

function validateSourceIdentities(
    draft: ClickHouseTableEditDraft,
    issues: ClickHouseEditValidationIssue[],
): void {
    const baselineNames = new Set(
        draft.baseline.columns.map((column) => column.name),
    );
    const currentNameCounts = new Map<string, number>();
    for (const column of draft.table.columns) {
        currentNameCounts.set(
            column.name,
            (currentNameCounts.get(column.name) ?? 0) + 1,
        );
    }

    const claimedSources = new Set<string>();
    for (const [columnIndex, column] of draft.table.columns.entries()) {
        const sourceName = draft.sourceColumnNameById[column.id] ?? null;
        if (sourceName == null) continue;
        if (!baselineNames.has(sourceName) || claimedSources.has(sourceName)) {
            addIssue(
                issues,
                "columnRenames",
                "列来源标识与远端基线冲突，请刷新结构后重试",
            );
        }
        claimedSources.add(sourceName);
        if (sourceName !== column.name && baselineNames.has(column.name)) {
            addIssue(
                issues,
                "columnRenames",
                `列 ${sourceName} 不能重命名为基线列 ${column.name}；ALTER 固定在 DROP COLUMN 之前执行`,
            );
        }
        if (
            sourceName !== column.name &&
            (currentNameCounts.get(column.name) ?? 0) > 1
        ) {
            addIssue(
                issues,
                "columnRenames",
                `列 ${sourceName} 的目标名称 ${column.name} 与其他列冲突`,
            );
        }
        if (!isSupportedTypeName(column.typeName)) {
            addIssue(
                issues,
                `columns.${columnIndex}.typeName`,
                `不支持安全编辑的列类型：${column.typeName || "<empty>"}`,
            );
        }
    }
}

function validateImmutableFields(
    draft: ClickHouseTableEditDraft,
    issues: ClickHouseEditValidationIssue[],
): void {
    const { baseline, table } = draft;
    if (
        table.database !== baseline.identity.database ||
        table.name !== baseline.identity.name
    ) {
        addIssue(issues, "identity", "当前阶段不支持修改数据库名或表名");
    }
    if (table.engineFamily !== baseline.engine.family) {
        addIssue(issues, "engineFamily", "当前阶段不支持修改表引擎");
    }
    if (
        JSON.stringify(table.engineArguments) !==
        JSON.stringify(baseline.engine.arguments)
    ) {
        addIssue(issues, "engineArguments", "当前阶段不支持修改表引擎参数");
    }
    if (table.orderBy !== baseline.keys.orderBy) {
        addIssue(issues, "orderBy", "当前阶段不支持修改 ORDER BY");
    }
    if (table.partitionBy !== (baseline.keys.partitionBy ?? "")) {
        addIssue(issues, "partitionBy", "当前阶段不支持修改 PARTITION BY");
    }
    if (table.primaryKey !== (baseline.keys.primaryKey ?? "")) {
        addIssue(issues, "primaryKey", "当前阶段不支持修改 PRIMARY KEY");
    }
}

function validateBaselineDependencies(
    draft: ClickHouseTableEditDraft,
    issues: ClickHouseEditValidationIssue[],
): void {
    if (draft.baseline.projections.length > 0) {
        addIssue(
            issues,
            "baseline.projections",
            "包含 Projection 的表将在后续阶段开放结构编辑",
        );
    }
    if (draft.baseline.skippingIndexes.length > 0) {
        addIssue(
            issues,
            "baseline.skippingIndexes",
            "包含 data-skipping index 的表将在后续阶段开放结构编辑",
        );
    }
}

function validateColumnAction(
    draft: ClickHouseTableEditDraft,
    action: ClickHouseColumnActionDraft | null,
    issues: ClickHouseEditValidationIssue[],
): void {
    if (!action) return;
    const column = draft.baseline.columns.find(
        (candidate) => candidate.name === action.columnName,
    );
    if (!column) {
        addIssue(
            issues,
            "pendingColumnAction.columnName",
            "列动作必须指向远端基线中存在的列",
        );
        return;
    }
    if (
        column.editability.mode !== "editable" ||
        column.editability.blockers.length > 0 ||
        column.defaultKind === "alias" ||
        column.defaultKind === "ephemeral"
    ) {
        addIssue(
            issues,
            "pendingColumnAction.columnName",
            "CLEAR 或 MATERIALIZE 只能作用于可编辑的存储列",
        );
    }
}

function isNoOp(draft: ClickHouseTableEditDraft): boolean {
    try {
        return (
            clickHouseEditDraftTargetKey(draft) ===
            clickHouseEditDraftTargetKey(
                clickHouseSchemaToEditDraft(draft.baseline),
            )
        );
    } catch {
        return false;
    }
}

export function validateClickHouseTableEditDraft(
    draft: ClickHouseTableEditDraft,
    pendingColumnAction: ClickHouseColumnActionDraft | null = null,
): ClickHouseEditValidationIssue[] {
    const issues: ClickHouseEditValidationIssue[] =
        validateClickHouseTableCreateDraft(draft.table).map(
            ({ path, message }) => ({ path, message }),
        );

    validateSourceIdentities(draft, issues);
    validateImmutableFields(draft, issues);
    validateBaselineDependencies(draft, issues);
    validateColumnAction(draft, pendingColumnAction, issues);

    if (pendingColumnAction == null && isNoOp(draft)) {
        addIssue(issues, "table", "表结构没有可提交的变更");
    }
    return issues;
}
