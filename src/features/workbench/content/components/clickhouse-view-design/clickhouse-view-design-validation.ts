import type {
    ClickHouseMaterializedStorage,
    ClickHouseViewDefinitionTarget,
    ClickHouseViewFamily,
    ClickHouseViewFamilyDefinition,
    ClickHouseViewInterval,
} from "@/types/ipc";
import type {
    ClickHouseViewDesignDraft,
    ClickHouseViewDesignIssue,
} from "@/types/clickhouse-view-design";

interface CreateClickHouseViewDraftInput {
    family: ClickHouseViewFamily;
    database: string | null;
    name: string;
    ownerTabRuntimeId: string | null;
}

const defaultInnerStorage = (): ClickHouseMaterializedStorage => ({
    kind: "inner_table",
    value: {
        engine: { family: "MergeTree", arguments: [] },
        orderBy: "tuple()",
        partitionBy: null,
        settings: [],
    },
});

function defaultFamilyDefinition(
    family: ClickHouseViewFamily,
): ClickHouseViewFamilyDefinition {
    switch (family) {
        case "normal":
            return { kind: "normal" };
        case "parameterized":
            return { kind: "parameterized", value: { parameters: [] } };
        case "temporary":
            return { kind: "temporary" };
        case "materialized":
            return {
                kind: "materialized",
                value: { storage: defaultInnerStorage(), populate: false },
            };
        case "refreshable_materialized":
            return {
                kind: "refreshable_materialized",
                value: {
                    storage: defaultInnerStorage(),
                    refresh: {
                        mode: "every",
                        interval: { value: 1, unit: "hour" },
                        offset: null,
                        randomizeFor: null,
                        dependencies: [],
                        settings: {
                            refreshRetries: null,
                            refreshRetryInitialBackoffMs: null,
                            refreshRetryMaxBackoffMs: null,
                            allReplicas: null,
                        },
                    },
                    append: false,
                    empty: false,
                },
            };
        case "window":
            return {
                kind: "window",
                value: {
                    destination: null,
                    innerEngine: null,
                    resultEngine: null,
                    watermark: { kind: "none" },
                    allowedLateness: null,
                    populate: false,
                    timeWindowFunction: "tumble",
                },
            };
        case "live":
            return {
                kind: "live",
                value: {
                    timeoutSeconds: null,
                    refreshSeconds: null,
                    canonicalLegacyOptions: [],
                },
            };
    }
}

export function createClickHouseViewDraft(
    input: CreateClickHouseViewDraftInput,
): ClickHouseViewDesignDraft {
    const temporary = input.family === "temporary";
    return {
        address: {
            database: temporary ? null : input.database,
            name: input.name,
            objectKind:
                input.family === "materialized" ||
                input.family === "refreshable_materialized"
                    ? "materialized_view"
                    : "view",
        },
        family: input.family,
        scope: temporary
            ? {
                  kind: "temporary",
                  value: { ownerTabRuntimeId: input.ownerTabRuntimeId ?? "" },
              }
            : { kind: "local" },
        columns:
            input.family === "materialized" ||
            input.family === "refreshable_materialized"
                ? { kind: "typed", value: [{ name: "value", typeName: "UInt64" }] }
                : { kind: "none" },
        query: "SELECT 1 AS value",
        security: { definer: null, sqlSecurity: null },
        comment: null,
        familyDefinition: defaultFamilyDefinition(input.family),
    };
}

export function cloneClickHouseViewDraft(
    draft: ClickHouseViewDesignDraft,
): ClickHouseViewDesignDraft {
    return structuredClone(draft);
}

export function clickHouseViewDraftKey(
    draft: ClickHouseViewDefinitionTarget,
): string {
    return JSON.stringify(draft);
}

function issue(
    issues: ClickHouseViewDesignIssue[],
    code: string,
    path: string,
    message: string,
): void {
    issues.push({ code, path, message });
}

function validateInterval(
    issues: ClickHouseViewDesignIssue[],
    interval: ClickHouseViewInterval | null,
    path: string,
): void {
    if (interval != null && (!Number.isInteger(interval.value) || interval.value <= 0)) {
        issue(issues, "interval_invalid", path, "时间间隔必须是正整数");
    }
}

function validateStorage(
    issues: ClickHouseViewDesignIssue[],
    storage: ClickHouseMaterializedStorage,
    path: string,
): void {
    if (storage.kind === "to_table") {
        const target = storage.value.target;
        if (
            target.kind !== "table" ||
            !target.database?.trim() ||
            !(target.table ?? target.objectName ?? "").trim()
        ) {
            issue(issues, "target_table_invalid", path, "TO 目标必须是有效的 ClickHouse 表");
        }
        return;
    }
    if (!storage.value.engine.family.trim()) {
        issue(issues, "engine_required", `${path}.engine`, "内部存储需要 Engine");
    }
    if (!storage.value.orderBy.trim()) {
        issue(issues, "order_by_required", `${path}.orderBy`, "MergeTree 内部存储需要 ORDER BY");
    }
}

function validateFamilyDefinition(
    draft: ClickHouseViewDesignDraft,
    issues: ClickHouseViewDesignIssue[],
): void {
    const definition = draft.familyDefinition;
    if (definition.kind !== draft.family) {
        issue(
            issues,
            "family_definition_mismatch",
            "familyDefinition.kind",
            "View family 与 family definition 不一致",
        );
        return;
    }

    switch (definition.kind) {
        case "normal":
        case "parameterized":
        case "temporary":
            return;
        case "materialized":
            validateStorage(issues, definition.value.storage, "familyDefinition.storage");
            if (definition.value.populate && definition.value.storage.kind === "to_table") {
                issue(
                    issues,
                    "populate_to_conflict",
                    "familyDefinition.populate",
                    "TO 与 POPULATE 不能同时使用",
                );
            }
            return;
        case "refreshable_materialized": {
            validateStorage(issues, definition.value.storage, "familyDefinition.storage");
            const refresh = definition.value.refresh;
            if (refresh.mode !== "dependsOnly" && refresh.interval == null) {
                issue(issues, "refresh_interval_required", "familyDefinition.refresh.interval", "EVERY/AFTER 需要时间间隔");
            }
            validateInterval(issues, refresh.interval, "familyDefinition.refresh.interval");
            validateInterval(issues, refresh.offset, "familyDefinition.refresh.offset");
            validateInterval(issues, refresh.randomizeFor, "familyDefinition.refresh.randomizeFor");
            if (
                refresh.dependencies.some(
                    (dependency) =>
                        dependency.database === draft.address.database &&
                        dependency.name === draft.address.name,
                )
            ) {
                issue(issues, "dependency_cycle", "familyDefinition.refresh.dependencies", "View 不能依赖自身");
            }
            return;
        }
        case "window":
            if (!definition.value.timeWindowFunction.trim()) {
                issue(issues, "time_window_required", "familyDefinition.timeWindowFunction", "Window View 需要时间窗口函数");
            }
            validateInterval(issues, definition.value.allowedLateness, "familyDefinition.allowedLateness");
            if (definition.value.watermark.kind === "bounded") {
                validateInterval(issues, definition.value.watermark.value, "familyDefinition.watermark");
            }
            return;
        case "live":
            if (definition.value.canonicalLegacyOptions.length > 0) {
                issue(issues, "legacy_options_readonly", "familyDefinition.canonicalLegacyOptions", "未知 legacy clause 只能无损只读");
            }
            return;
    }
}

export function validateClickHouseViewDraft(
    draft: ClickHouseViewDesignDraft,
): ClickHouseViewDesignIssue[] {
    const issues: ClickHouseViewDesignIssue[] = [];
    const temporary = draft.family === "temporary";
    if (!draft.address.name.trim()) {
        issue(issues, "name_required", "address.name", "View 名称不能为空");
    }
    if (!draft.query.trim()) {
        issue(issues, "query_required", "query", "查询不能为空");
    }
    const expectedKind =
        draft.family === "materialized" ||
        draft.family === "refreshable_materialized"
            ? "materialized_view"
            : "view";
    if (draft.address.objectKind !== expectedKind) {
        issue(issues, "object_kind_mismatch", "address.objectKind", "对象类型与 View family 不一致");
    }
    if (temporary) {
        if (draft.address.database != null) {
            issue(issues, "temporary_database_forbidden", "address.database", "Temporary View 不属于数据库");
        }
        if (draft.scope.kind !== "temporary" || !draft.scope.value.ownerTabRuntimeId.trim()) {
            issue(issues, "temporary_owner_required", "scope", "Temporary View 必须绑定 owner SQL runtime");
        }
    } else {
        if (!draft.address.database?.trim()) {
            issue(issues, "database_required", "address.database", "持久化 View 需要数据库");
        }
        if (draft.scope.kind === "temporary") {
            issue(issues, "persistent_scope_invalid", "scope", "持久化 View 不能使用 Temporary scope");
        }
    }
    validateFamilyDefinition(draft, issues);
    return issues;
}
