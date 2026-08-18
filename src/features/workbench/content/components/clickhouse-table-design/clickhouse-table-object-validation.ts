import type {
    ClickHouseProjectionCreateDraft,
    ClickHouseSkippingIndexCreateDraft,
    ClickHouseTableObjectActionDraft,
} from "@/types/clickhouse-table-design";
import type {
    ClickHouseTableSchema,
    NativeSchemaChangeTarget,
} from "@/types/ipc";

import { cloneClickHouseTableSchema } from "./clickhouse-table-edit-draft";

export interface ClickHouseTableObjectValidationIssue {
    path: string;
    message: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROJECTION_FORBIDDEN_TOP_LEVEL = new Set([
    "FROM",
    "JOIN",
    "UNION",
    "PREWHERE",
    "LIMIT",
    "OFFSET",
    "INTO",
    "FORMAT",
    "SETTINGS",
]);

interface SqlScanResult {
    valid: boolean;
    topLevelWords: string[];
}

function scanControlledSql(value: string): SqlScanResult {
    const words: string[] = [];
    const stack: string[] = [];
    let quote: "'" | '"' | "`" | null = null;
    let escaped = false;
    let word = "";

    const flushWord = (): void => {
        if (word.length > 0 && stack.length === 0) {
            words.push(word.toUpperCase());
        }
        word = "";
    };

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]!;
        const next = value[index + 1];
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (character === "\\") {
                escaped = true;
            } else if (character === quote) {
                if (next === quote) {
                    index += 1;
                } else {
                    quote = null;
                }
            }
            continue;
        }

        if (character === "'" || character === '"' || character === "`") {
            flushWord();
            quote = character;
            continue;
        }
        if (
            character === ";" ||
            character === "#" ||
            (character === "-" && next === "-") ||
            (character === "/" && next === "*")
        ) {
            return { valid: false, topLevelWords: words };
        }
        if (character === "(" || character === "[" || character === "{") {
            flushWord();
            stack.push(character);
            continue;
        }
        if (character === ")" || character === "]" || character === "}") {
            flushWord();
            const expected = character === ")" ? "(" : character === "]" ? "[" : "{";
            if (stack.pop() !== expected) {
                return { valid: false, topLevelWords: words };
            }
            continue;
        }
        if (/[A-Za-z0-9_]/u.test(character)) {
            word += character;
        } else {
            flushWord();
        }
    }
    flushWord();
    return {
        valid: quote == null && stack.length === 0,
        topLevelWords: words,
    };
}

function baselineIssues(
    baseline: ClickHouseTableSchema,
): ClickHouseTableObjectValidationIssue[] {
    return baseline.editability.mode === "editable" &&
        baseline.editability.blockers.length === 0
        ? []
        : [
              {
                  path: "baseline",
                  message: "远端表结构当前不可安全编辑，请刷新后重试",
              },
          ];
}

function identifierIssue(name: string): ClickHouseTableObjectValidationIssue[] {
    return IDENTIFIER_PATTERN.test(name.trim())
        ? []
        : [{ path: "name", message: "对象名称必须是有效的 ClickHouse 标识符" }];
}

export function validateClickHouseProjectionDraft(
    draft: ClickHouseProjectionCreateDraft,
    baseline: ClickHouseTableSchema,
): ClickHouseTableObjectValidationIssue[] {
    const issues = [...baselineIssues(baseline), ...identifierIssue(draft.name)];
    const name = draft.name.trim();
    if (baseline.projections.some((projection) => projection.name === name)) {
        issues.push({ path: "name", message: `Projection ${name} 已存在` });
    }

    const query = draft.query.trim();
    const scan = scanControlledSql(query);
    if (
        query.length === 0 ||
        !scan.valid ||
        scan.topLevelWords[0] !== "SELECT" ||
        scan.topLevelWords.slice(1).includes("SELECT") ||
        scan.topLevelWords.some((word) =>
            PROJECTION_FORBIDDEN_TOP_LEVEL.has(word),
        )
    ) {
        issues.push({
            path: "query",
            message:
                "Projection query 必须是受控单条 SELECT，且不能包含 FROM/JOIN/UNION/PREWHERE/LIMIT/OFFSET/INTO/FORMAT/SETTINGS、注释或分号",
        });
    }
    return dedupeIssues(issues);
}

function parseSafeUnsignedInteger(value: string): number | null {
    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function validateIndexArguments(
    draft: ClickHouseSkippingIndexCreateDraft,
    issues: ClickHouseTableObjectValidationIssue[],
): void {
    const argumentsPath = "typeArguments";
    const requireUnsigned = (positions: number[], positivePositions: number[]): void => {
        for (const position of positions) {
            const value = parseSafeUnsignedInteger(draft.typeArguments[position] ?? "");
            if (value == null || (positivePositions.includes(position) && value === 0)) {
                issues.push({
                    path: `${argumentsPath}.${position}`,
                    message: "索引参数必须是 JavaScript 安全范围内的无符号整数",
                });
            }
        }
    };

    switch (draft.indexType) {
        case "minmax":
            if (draft.typeArguments.length !== 0) {
                issues.push({ path: argumentsPath, message: "minmax 不接受参数" });
            }
            break;
        case "set":
            if (draft.typeArguments.length !== 1) {
                issues.push({ path: argumentsPath, message: "set 要求 1 个参数" });
            } else {
                requireUnsigned([0], []);
            }
            break;
        case "bloom_filter":
            if (draft.typeArguments.length > 1) {
                issues.push({
                    path: argumentsPath,
                    message: "bloom_filter 最多接受 1 个参数",
                });
            } else if (draft.typeArguments.length === 1) {
                const value = Number(draft.typeArguments[0]!.trim());
                if (!Number.isFinite(value) || value <= 0 || value >= 1) {
                    issues.push({
                        path: `${argumentsPath}.0`,
                        message: "bloom_filter 参数必须满足 0 < value < 1",
                    });
                }
            }
            break;
        case "ngrambf_v1":
            if (draft.typeArguments.length !== 4) {
                issues.push({
                    path: argumentsPath,
                    message: "ngrambf_v1 要求 4 个参数",
                });
            } else {
                requireUnsigned([0, 1, 2, 3], [0, 1, 2]);
            }
            break;
        case "tokenbf_v1":
            if (draft.typeArguments.length !== 3) {
                issues.push({
                    path: argumentsPath,
                    message: "tokenbf_v1 要求 3 个参数",
                });
            } else {
                requireUnsigned([0, 1, 2], [0, 1]);
            }
            break;
    }
}

export function validateClickHouseSkippingIndexDraft(
    draft: ClickHouseSkippingIndexCreateDraft,
    baseline: ClickHouseTableSchema,
): ClickHouseTableObjectValidationIssue[] {
    const issues = [...baselineIssues(baseline), ...identifierIssue(draft.name)];
    const name = draft.name.trim();
    if (baseline.skippingIndexes.some((index) => index.name === name)) {
        issues.push({ path: "name", message: `Data-skipping Index ${name} 已存在` });
    }

    const expression = draft.expression.trim();
    if (expression.length === 0 || !scanControlledSql(expression).valid) {
        issues.push({
            path: "expression",
            message: "索引表达式必须是无注释、无分号且 delimiter 平衡的单表达式",
        });
    }
    const granularity = parseSafeUnsignedInteger(draft.granularity);
    if (granularity == null || granularity === 0) {
        issues.push({
            path: "granularity",
            message: "GRANULARITY 必须是 JavaScript 安全范围内的正整数",
        });
    }
    validateIndexArguments(draft, issues);
    return dedupeIssues(issues);
}

function assertEditableExistingObject(
    action: ClickHouseTableObjectActionDraft,
    baseline: ClickHouseTableSchema,
): void {
    const object =
        action.objectKind === "projection"
            ? baseline.projections.find((candidate) => candidate.name === action.name)
            : baseline.skippingIndexes.find((candidate) => candidate.name === action.name);
    if (
        !object ||
        object.editability.mode !== "editable" ||
        object.editability.blockers.length > 0
    ) {
        throw new Error(
            `ClickHouse ${action.objectKind} action requires an editable object from the current baseline`,
        );
    }
}

export function buildClickHouseTableObjectTarget(
    action: ClickHouseTableObjectActionDraft,
    baseline: ClickHouseTableSchema,
): NativeSchemaChangeTarget {
    if (baselineIssues(baseline).length > 0) {
        throw new Error("ClickHouse table-object action requires an editable table baseline");
    }
    const clonedBaseline = cloneClickHouseTableSchema(baseline);
    if (action.operation === "create") {
        if (action.objectKind === "projection") {
            if (!action.definition || action.definition.name !== action.name) {
                throw new Error("Projection create requires a matching definition");
            }
            const issues = validateClickHouseProjectionDraft(action.definition, baseline);
            if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
            return {
                kind: "clickhouse_projection_create",
                target: {
                    baseline: clonedBaseline,
                    projection: {
                        name: action.definition.name.trim(),
                        query: action.definition.query.trim(),
                    },
                },
            };
        }
        if (!action.definition || action.definition.name !== action.name) {
            throw new Error("Skipping-index create requires a matching definition");
        }
        const issues = validateClickHouseSkippingIndexDraft(action.definition, baseline);
        if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join("; "));
        const granularity = parseSafeUnsignedInteger(action.definition.granularity);
        if (granularity == null) throw new Error("Invalid skipping-index granularity");
        return {
            kind: "clickhouse_skipping_index_create",
            target: {
                baseline: clonedBaseline,
                index: {
                    name: action.definition.name.trim(),
                    expression: action.definition.expression.trim(),
                    indexType: action.definition.indexType,
                    typeArguments: action.definition.typeArguments.map((argument) =>
                        argument.trim(),
                    ),
                    granularity,
                },
            },
        };
    }

    if (action.definition != null) {
        throw new Error("Existing table-object actions cannot carry a create definition");
    }
    assertEditableExistingObject(action, baseline);
    if (action.objectKind === "projection") {
        const target = {
            baseline: clonedBaseline,
            projectionName: action.name,
        };
        switch (action.operation) {
            case "drop":
                return { kind: "clickhouse_projection_drop", target };
            case "clear":
                return { kind: "clickhouse_projection_clear", target };
            case "materialize":
                return { kind: "clickhouse_projection_materialize", target };
        }
    }
    const target = { baseline: clonedBaseline, indexName: action.name };
    switch (action.operation) {
        case "drop":
            return { kind: "clickhouse_skipping_index_drop", target };
        case "clear":
            return { kind: "clickhouse_skipping_index_clear", target };
        case "materialize":
            return { kind: "clickhouse_skipping_index_materialize", target };
    }
}

export function clickHouseTableObjectTargetKey(
    target: NativeSchemaChangeTarget,
): string {
    switch (target.kind) {
        case "clickhouse_projection_create":
            return JSON.stringify({ kind: target.kind, projection: target.target.projection });
        case "clickhouse_projection_drop":
        case "clickhouse_projection_clear":
        case "clickhouse_projection_materialize":
            return JSON.stringify({
                kind: target.kind,
                projectionName: target.target.projectionName,
            });
        case "clickhouse_skipping_index_create":
            return JSON.stringify({ kind: target.kind, index: target.target.index });
        case "clickhouse_skipping_index_drop":
        case "clickhouse_skipping_index_clear":
        case "clickhouse_skipping_index_materialize":
            return JSON.stringify({ kind: target.kind, indexName: target.target.indexName });
        default:
            throw new Error("ClickHouse table-object target key requires a projection or data-skipping index target");
    }
}

function dedupeIssues(
    issues: ClickHouseTableObjectValidationIssue[],
): ClickHouseTableObjectValidationIssue[] {
    return issues.filter(
        (issue, index) =>
            issues.findIndex(
                (candidate) =>
                    candidate.path === issue.path && candidate.message === issue.message,
            ) === index,
    );
}
