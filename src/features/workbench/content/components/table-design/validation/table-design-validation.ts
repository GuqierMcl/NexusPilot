import type { TableSchemaDraft } from "@/types/table-design";
import type { TableDesignDriverProfile } from "../driver-profiles";
import { splitColumnList } from "../table-design-utils";

export interface TableDesignValidationIssue {
    severity: "error" | "warning";
    scope: "table" | "column" | "index" | "constraint" | "partition";
    rowId?: string;
    field?: string;
    message: string;
}

function isPositiveInteger(value: string): boolean {
    return /^[1-9]\d*$/.test(value.trim());
}

function issue(
    severity: TableDesignValidationIssue["severity"],
    scope: TableDesignValidationIssue["scope"],
    message: string,
    rowId?: string,
    field?: string,
): TableDesignValidationIssue {
    return { severity, scope, message, rowId, field };
}

export function validateTableDesignDraft(
    draft: TableSchemaDraft,
    profile: TableDesignDriverProfile,
    mode: "create" | "edit",
): TableDesignValidationIssue[] {
    const issues: TableDesignValidationIssue[] = [];

    if (mode === "create" && draft.basics.tableName.trim().length === 0) {
        issues.push(issue("error", "table", "表名不能为空", undefined, "tableName"));
    }

    const seenColumnNames = new Map<string, string>();
    for (const column of draft.columns) {
        const name = column.name.trim();
        if (!name) {
            issues.push(issue("error", "column", "列名不能为空", column.id, "name"));
        } else if (seenColumnNames.has(name.toLowerCase())) {
            issues.push(issue("error", "column", `列名重复：${name}`, column.id, "name"));
        } else {
            seenColumnNames.set(name.toLowerCase(), column.id);
        }

        if (!column.typeName.trim()) {
            issues.push(
                issue(
                    "error",
                    "column",
                    `列 ${name || "(未命名)"} 缺少类型`,
                    column.id,
                    "typeName",
                ),
            );
        }

        const typeDraft = column.typeDraft;
        if (typeDraft.mode === "raw") {
            issues.push(
                issue(
                    "warning",
                    "column",
                    `列 ${name || "(未命名)"} 使用 Raw 类型，前端不会校验类型参数`,
                    column.id,
                    "typeName",
                ),
            );
        }

        for (const [field, label] of [
            ["length", "长度"],
            ["precision", "精度"],
            ["scale", "小数位"],
            ["timePrecision", "时间精度"],
        ] as const) {
            const value = typeDraft[field].trim();
            if (value && !isPositiveInteger(value)) {
                issues.push(issue("error", "column", `${label}必须是正整数`, column.id, field));
            }
        }

        if (
            typeDraft.precision.trim() &&
            typeDraft.scale.trim() &&
            Number(typeDraft.scale) > Number(typeDraft.precision)
        ) {
            issues.push(issue("error", "column", "小数位不能大于精度", column.id, "scale"));
        }

        if (column.isPrimaryKey && column.nullable) {
            issues.push(
                issue(
                    "warning",
                    "column",
                    `主键列 ${name || "(未命名)"} 建议设置为不可空`,
                    column.id,
                    "nullable",
                ),
            );
        }

        if (typeDraft.unsigned && !profile.columnOptions.unsigned) {
            issues.push(
                issue(
                    "error",
                    "column",
                    `${profile.displayName} 不支持当前类型的 unsigned 设置`,
                    column.id,
                    "unsigned",
                ),
            );
        }
    }

    const columnNameSet = new Set(
        draft.columns.map((column) => column.name.trim()).filter(Boolean),
    );

    for (const index of draft.indexes) {
        for (const columnName of splitColumnList(index.columns)) {
            if (!columnNameSet.has(columnName)) {
                issues.push(
                    issue(
                        "error",
                        "index",
                        `索引 ${index.name || "(未命名)"} 引用了不存在的列：${columnName}`,
                        index.id,
                        "columns",
                    ),
                );
            }
        }
    }

    for (const constraint of draft.constraints) {
        for (const columnName of splitColumnList(constraint.columns)) {
            if (!columnNameSet.has(columnName)) {
                issues.push(
                    issue(
                        "error",
                        "constraint",
                        `约束 ${constraint.name || "(未命名)"} 引用了不存在的列：${columnName}`,
                        constraint.id,
                        "columns",
                    ),
                );
            }
        }

        if (constraint.kind === "foreign_key") {
            if (!constraint.referenceTable.trim()) {
                issues.push(
                    issue("error", "constraint", "外键约束缺少引用表", constraint.id, "referenceTable"),
                );
            }
            if (splitColumnList(constraint.referenceColumns).length === 0) {
                issues.push(
                    issue("error", "constraint", "外键约束缺少引用列", constraint.id, "referenceColumns"),
                );
            }
        }

        if (constraint.kind === "check" && !constraint.expression.trim()) {
            issues.push(
                issue("error", "constraint", "CHECK 约束缺少表达式", constraint.id, "expression"),
            );
        }
    }

    return issues;
}

export function hasValidationErrors(issues: TableDesignValidationIssue[]): boolean {
    return issues.some((item) => item.severity === "error");
}
