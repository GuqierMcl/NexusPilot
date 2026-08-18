import type { ClickHouseTableCreateDraft } from "@/types/clickhouse-table-design";
import type { ClickHouseCreateTableTarget } from "@/types/ipc";

export interface ClickHouseCreateValidationIssue {
    code: string;
    path: string;
    message: string;
}

const ENGINE_ARITY: Readonly<Record<string, readonly [number, number]>> = {
    MergeTree: [0, 0],
    ReplacingMergeTree: [0, 1],
    SummingMergeTree: [0, 1],
    AggregatingMergeTree: [0, 0],
    CollapsingMergeTree: [1, 1],
    VersionedCollapsingMergeTree: [2, 2],
};

const CODEC_NAMES = new Set([
    "LZ4",
    "ZSTD",
    "Delta",
    "DoubleDelta",
    "Gorilla",
    "T64",
    "FPC",
]);

const SETTING_NAMES = new Set([
    "index_granularity",
    "index_granularity_bytes",
    "allow_nullable_key",
    "ttl_only_drop_parts",
]);

const MAX_U64 = 18_446_744_073_709_551_615n;

function addIssue(
    issues: ClickHouseCreateValidationIssue[],
    code: string,
    path: string,
    message: string,
): void {
    issues.push({ code, path, message });
}

function validateIdentifier(
    issues: ClickHouseCreateValidationIssue[],
    value: string,
    path: string,
    label: string,
): void {
    if (value.length === 0) {
        addIssue(issues, "required", path, `请输入${label}`);
        return;
    }
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
        addIssue(issues, "invalid_value", path, `${label}不能包含控制字符`);
    }
}

function matchingDelimiter(opening: string): string {
    switch (opening) {
        case "(":
            return ")";
        case "[":
            return "]";
        case "{":
            return "}";
        default:
            return "";
    }
}

function expressionBoundaryError(expression: string): string | null {
    if (expression.trim().length === 0) return "表达式不能为空";

    const delimiters: string[] = [];
    let quote: "'" | '"' | "`" | null = null;
    let escaped = false;

    for (let index = 0; index < expression.length; index += 1) {
        const character = expression[index];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (character === "\\") {
                escaped = true;
                continue;
            }
            if (character === quote) {
                if (expression[index + 1] === quote) {
                    index += 1;
                } else {
                    quote = null;
                }
            }
            continue;
        }

        if (character === "'" || character === '"' || character === "`") {
            quote = character;
            continue;
        }
        if (
            (character === "-" && expression[index + 1] === "-") ||
            character === "#" ||
            (character === "/" && expression[index + 1] === "*")
        ) {
            return "表达式不能包含 SQL 注释";
        }
        if (character === "(" || character === "[" || character === "{") {
            delimiters.push(matchingDelimiter(character));
            continue;
        }
        if (character === ")" || character === "]" || character === "}") {
            if (delimiters.pop() !== character) {
                return "表达式包含不匹配的分隔符";
            }
            continue;
        }
        if (character === ";" && delimiters.length === 0) {
            return "表达式必须且只能包含一个表达式";
        }
    }

    if (quote) return "表达式包含未闭合的引号";
    if (delimiters.length > 0) return "表达式包含未闭合的分隔符";
    return null;
}

function validateExpression(
    issues: ClickHouseCreateValidationIssue[],
    expression: string,
    path: string,
    required: boolean,
): void {
    if (!required && expression.trim().length === 0) return;
    const error = expressionBoundaryError(expression);
    if (error) addIssue(issues, "invalid_expression", path, error);
}

function parseU64(value: string): bigint | null {
    if (!/^\d+$/u.test(value)) return null;
    try {
        const parsed = BigInt(value);
        return parsed <= MAX_U64 ? parsed : null;
    } catch {
        return null;
    }
}

function validateSettingValue(
    issues: ClickHouseCreateValidationIssue[],
    name: string,
    value: string,
    path: string,
): void {
    switch (name) {
        case "index_granularity": {
            const parsed = parseU64(value);
            if (parsed == null || parsed === 0n) {
                addIssue(
                    issues,
                    "invalid_value",
                    path,
                    "index_granularity 必须是正整数",
                );
            }
            break;
        }
        case "index_granularity_bytes":
            if (parseU64(value) == null) {
                addIssue(
                    issues,
                    "invalid_value",
                    path,
                    "index_granularity_bytes 必须是无符号整数",
                );
            }
            break;
        case "allow_nullable_key":
        case "ttl_only_drop_parts":
            if (value !== "0" && value !== "1") {
                addIssue(issues, "invalid_value", path, "设置值必须是 0 或 1");
            }
            break;
        default:
            break;
    }
}

export function validateClickHouseTableCreateDraft(
    draft: ClickHouseTableCreateDraft,
): ClickHouseCreateValidationIssue[] {
    const issues: ClickHouseCreateValidationIssue[] = [];
    validateIdentifier(issues, draft.database, "database", "数据库名");
    validateIdentifier(issues, draft.name, "name", "表名");

    if (draft.columns.length === 0) {
        addIssue(issues, "required", "columns", "至少需要一个列");
    }
    const columnNames = new Set<string>();
    draft.columns.forEach((column, columnIndex) => {
        const path = `columns.${columnIndex}`;
        validateIdentifier(issues, column.name, `${path}.name`, "列名");
        if (column.name.length > 0) {
            if (columnNames.has(column.name)) {
                addIssue(
                    issues,
                    "duplicate",
                    `${path}.name`,
                    `列名 ${column.name} 重复`,
                );
            }
            columnNames.add(column.name);
        }

        if (column.typeName.trim().length === 0) {
            addIssue(issues, "required", `${path}.typeName`, "请输入列类型");
        }

        if (column.defaultKind === "none") {
            if (column.defaultExpression.trim().length > 0) {
                addIssue(
                    issues,
                    "invalid_pairing",
                    `${path}.defaultExpression`,
                    "未选择默认值类型时不能填写默认表达式",
                );
            }
        } else {
            validateExpression(
                issues,
                column.defaultExpression,
                `${path}.defaultExpression`,
                true,
            );
        }

        column.codecs.forEach((codec, codecIndex) => {
            const codecPath = `${path}.codecs.${codecIndex}`;
            if (codec.name.length === 0) {
                addIssue(issues, "required", `${codecPath}.name`, "请选择 Codec");
            } else if (!CODEC_NAMES.has(codec.name)) {
                addIssue(
                    issues,
                    "unsupported",
                    `${codecPath}.name`,
                    `不支持的 Codec：${codec.name}`,
                );
            }
            codec.arguments.forEach((argument, argumentIndex) => {
                validateExpression(
                    issues,
                    argument,
                    `${codecPath}.arguments.${argumentIndex}`,
                    true,
                );
            });
        });

        validateExpression(
            issues,
            column.ttlExpression,
            `${path}.ttlExpression`,
            false,
        );
    });

    if (draft.engineFamily.length === 0) {
        addIssue(issues, "required", "engineFamily", "请选择表引擎");
    } else {
        const arity = ENGINE_ARITY[draft.engineFamily];
        if (!arity) {
            addIssue(
                issues,
                "unsupported",
                "engineFamily",
                `不支持的表引擎：${draft.engineFamily}`,
            );
        } else if (
            draft.engineArguments.length < arity[0] ||
            draft.engineArguments.length > arity[1]
        ) {
            addIssue(
                issues,
                "invalid_arity",
                "engineFamily",
                `${draft.engineFamily} 的引擎参数数量不正确`,
            );
        }
    }
    draft.engineArguments.forEach((argument, argumentIndex) => {
        validateExpression(
            issues,
            argument,
            `engineArguments.${argumentIndex}`,
            true,
        );
    });

    validateExpression(issues, draft.orderBy, "orderBy", true);
    validateExpression(issues, draft.partitionBy, "partitionBy", false);
    validateExpression(issues, draft.primaryKey, "primaryKey", false);
    validateExpression(issues, draft.sampleBy, "sampleBy", false);
    validateExpression(issues, draft.tableTtl, "tableTtl", false);

    const settingNames = new Set<string>();
    draft.settings.forEach((setting, settingIndex) => {
        const path = `settings.${settingIndex}`;
        if (setting.name.length === 0) {
            addIssue(issues, "required", `${path}.name`, "请选择设置项");
        } else {
            if (settingNames.has(setting.name)) {
                addIssue(
                    issues,
                    "duplicate",
                    `${path}.name`,
                    `设置项 ${setting.name} 重复`,
                );
            }
            settingNames.add(setting.name);
            if (!SETTING_NAMES.has(setting.name)) {
                addIssue(
                    issues,
                    "unsupported",
                    `${path}.name`,
                    `不支持的设置项：${setting.name}`,
                );
            } else {
                validateSettingValue(
                    issues,
                    setting.name,
                    setting.value,
                    `${path}.value`,
                );
            }
        }
    });

    return issues;
}

export function hasClickHouseCreateErrors(
    issues: readonly ClickHouseCreateValidationIssue[],
): boolean {
    return issues.length > 0;
}

export function clickHouseCreateTargetKey(
    target: ClickHouseCreateTableTarget,
): string {
    return JSON.stringify(target);
}
