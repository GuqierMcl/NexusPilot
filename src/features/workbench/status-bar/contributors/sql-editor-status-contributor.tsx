import { CircleAlert, LoaderCircle, Rows3, Save } from "lucide-react";

import type { WorkbenchTab } from "@/store";
import type {
    JsonSafeInteger,
    SqlExecutionSnapshot,
    SqlExecutionState,
} from "@/types/ipc";

import type {
    WorkbenchStatusContext,
    WorkbenchStatusContributor,
    WorkbenchStatusIcon,
    WorkbenchStatusItemModel,
} from "../types";

const BACKGROUND_ACTIVE_STATES = new Set<SqlExecutionState>([
    "starting",
    "running",
    "canceling",
]);

const BACKGROUND_FAILURE_STATES = new Set<SqlExecutionState>([
    "failed",
    "timedOut",
    "cancelFailed",
]);

export function formatJsonSafeCount(value: JsonSafeInteger): string {
    const normalized = BigInt(String(value)).toString();
    const sign = normalized.startsWith("-") ? "-" : "";
    const digits = sign ? normalized.slice(1) : normalized;
    return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

export function formatJsonSafeBytes(value: JsonSafeInteger): string {
    const units = ["B", "KiB", "MiB", "GiB"] as const;
    let amount = BigInt(String(value));
    let unitIndex = 0;
    while (amount >= 1_024n && unitIndex < units.length - 1) {
        amount /= 1_024n;
        unitIndex += 1;
    }
    return `${amount.toString()} ${units[unitIndex]}`;
}

function formatElapsed(snapshot: SqlExecutionSnapshot, nowMs: number): string {
    const end = snapshot.finishedAt ?? nowMs;
    const elapsedMs = Math.max(0, end - snapshot.startedAt);
    return `${(elapsedMs / 1_000).toFixed(1)}s`;
}

export function getSqlExecutionStateLabel(
    snapshot: SqlExecutionSnapshot,
    nowMs: number,
): string {
    switch (snapshot.state) {
        case "queued":
        case "starting":
            return "准备执行";
        case "running":
            return `正在执行 · ${snapshot.statementClass.toUpperCase()} · ${formatElapsed(snapshot, nowMs)}`;
        case "canceling":
            return "正在取消";
        case "succeeded":
            return "查询已完成";
        case "canceled":
            return "查询已取消";
        case "timedOut":
            return "查询超时";
        case "failed":
            return "查询失败";
        case "cancelFailed":
            return "取消未确认";
    }
}

function getExecutionTone(
    state: SqlExecutionState,
): WorkbenchStatusItemModel["tone"] {
    if (
        state === "failed" ||
        state === "timedOut" ||
        state === "cancelFailed"
    ) {
        return "error";
    }
    if (state === "succeeded") return "success";
    if (state === "canceling" || state === "canceled") return "warning";
    return "default";
}

function getExecutionIcon(snapshot: SqlExecutionSnapshot): WorkbenchStatusIcon {
    if (BACKGROUND_ACTIVE_STATES.has(snapshot.state)) return LoaderCircle;
    if (BACKGROUND_FAILURE_STATES.has(snapshot.state)) return CircleAlert;
    return Rows3;
}

function buildExecutionMetricItems(
    snapshot: SqlExecutionSnapshot,
): WorkbenchStatusItemModel[] {
    const items: WorkbenchStatusItemModel[] = [];
    const summary = snapshot.summary;
    const primaryRows = summary?.resultRows ?? summary?.writtenRows;
    if (primaryRows !== undefined) {
        items.push({
            id: "sql-editor-execution-primary-rows",
            area: "right",
            priority: 10,
            icon: Rows3,
            label: `${summary?.resultRows !== undefined ? "结果" : "写入"} ${formatJsonSafeCount(primaryRows)} 行`,
            title: "当前 SQL 执行的结果或写入行数",
            tone: "muted",
            width: "compact",
        });
    }
    if (summary?.readRows !== undefined) {
        items.push({
            id: "sql-editor-execution-read-rows",
            area: "right",
            priority: 11,
            icon: Rows3,
            label: `读取 ${formatJsonSafeCount(summary.readRows)} 行`,
            title: "当前 SQL 执行的读取行数",
            tone: "muted",
            width: "compact",
        });
    }
    const bytes =
        summary?.resultBytes ??
        summary?.writtenBytes ??
        summary?.readBytes ??
        (snapshot.outcome?.kind === "raw"
            ? snapshot.outcome.byteLength
            : undefined);
    if (bytes !== undefined) {
        items.push({
            id: "sql-editor-execution-bytes",
            area: "right",
            priority: 12,
            label: formatJsonSafeBytes(bytes),
            title: "当前 SQL 执行的数据量",
            tone: "muted",
            width: "compact",
        });
    }
    if (items.length === 0 && snapshot.outcome?.kind === "rows") {
        items.push({
            id: "sql-editor-execution-result-rows",
            area: "right",
            priority: 10,
            icon: Rows3,
            label: `${snapshot.outcome.result.rows.length} 行`,
            title: "最近一次查询返回的行数",
            tone: "muted",
            width: "compact",
        });
    }
    return items;
}

function buildActiveExecutionItems(
    context: WorkbenchStatusContext,
    tab: Extract<WorkbenchTab, { type: "sql_editor" }>,
    snapshot: SqlExecutionSnapshot,
): WorkbenchStatusItemModel[] {
    const Icon = getExecutionIcon(snapshot);
    return [
        {
            id: "sql-editor-execution",
            area: "left",
            priority: 10,
            icon: Icon,
            iconClassName: BACKGROUND_ACTIVE_STATES.has(snapshot.state)
                ? "animate-spin"
                : undefined,
            label: getSqlExecutionStateLabel(snapshot, context.nowMs),
            title:
                snapshot.failure?.message ??
                "打开当前 SQL 的执行详情",
            tone: getExecutionTone(snapshot.state),
            width: "content",
            onClick: () =>
                context.actions.openSqlExecutionDetails(tab.id),
        },
        ...buildExecutionMetricItems(snapshot),
    ];
}

function navigateToExecutionTargets(
    context: WorkbenchStatusContext,
    tabIds: string[],
): void {
    if (tabIds.length === 1 && tabIds[0]) {
        context.actions.focusTab(tabIds[0]);
        context.actions.openSqlExecutionDetails(tabIds[0]);
        return;
    }
    context.actions.openExecutionOverview(tabIds);
}

function buildBackgroundItems(
    context: WorkbenchStatusContext,
): WorkbenchStatusItemModel[] {
    const activeTabId = context.activeTab?.id ?? null;
    const backgroundExecutions = context.tabs.flatMap((tab) => {
        if (tab.type !== "sql_editor" || tab.id === activeTabId) return [];
        const snapshot =
            context.tabRuntimeState.sqlEditorByTabId[tab.id]?.activeExecution;
        return snapshot ? [{ tabId: tab.id, snapshot }] : [];
    });
    const activeTabIds = backgroundExecutions
        .filter(({ snapshot }) =>
            BACKGROUND_ACTIVE_STATES.has(snapshot.state),
        )
        .map(({ tabId }) => tabId);
    const failedTabIds = backgroundExecutions
        .filter(({ snapshot }) =>
            BACKGROUND_FAILURE_STATES.has(snapshot.state),
        )
        .map(({ tabId }) => tabId);
    const items: WorkbenchStatusItemModel[] = [];

    if (activeTabIds.length > 0) {
        items.push({
            id: "sql-editor-background-running",
            area: "right",
            priority: 30,
            icon: LoaderCircle,
            iconClassName: "animate-spin",
            label: `${activeTabIds.length} 个后台查询执行中`,
            title: "查看后台 SQL 执行",
            tone: "default",
            width: "compact",
            onClick: () =>
                navigateToExecutionTargets(context, activeTabIds),
        });
    }
    if (failedTabIds.length > 0) {
        items.push({
            id: "sql-editor-background-failed",
            area: "right",
            priority: 5,
            icon: CircleAlert,
            label: `${failedTabIds.length} 个后台查询失败`,
            title: "查看后台 SQL 失败详情",
            tone: "error",
            width: "compact",
            onClick: () =>
                navigateToExecutionTargets(context, failedTabIds),
        });
    }
    return items;
}

function buildLegacyActiveTabItems(
    tab: Extract<WorkbenchTab, { type: "sql_editor" }>,
    context: WorkbenchStatusContext,
): WorkbenchStatusItemModel[] {
    const runtimeState = context.tabRuntimeState.sqlEditorByTabId[tab.id];
    if (tab.isExecuting) {
        return [
            {
                id: "sql-editor-running",
                area: "left",
                priority: 10,
                icon: LoaderCircle,
                iconClassName: "animate-spin",
                label: "正在查询",
                title: "SQL 查询正在执行",
                tone: "default",
                width: "compact",
            },
        ];
    }
    if (runtimeState?.error) {
        return [
            {
                id: "sql-editor-error",
                area: "left",
                priority: 10,
                icon: CircleAlert,
                label: "查询失败",
                title: runtimeState.error.message,
                tone: "error",
                width: "compact",
            },
        ];
    }
    if (runtimeState?.result) {
        return [
            {
                id: "sql-editor-result",
                area: "right",
                priority: 20,
                icon: Rows3,
                label: `${runtimeState.result.rows.length} 行`,
                title: "最近一次查询返回的行数",
                tone: "muted",
                width: "compact",
            },
        ];
    }
    if (tab.isDirty) {
        return [
            {
                id: "sql-editor-dirty",
                area: "left",
                priority: 30,
                icon: Save,
                label: "查询有未保存修改",
                title: "保存查询存在未保存修改",
                tone: "warning",
                width: "compact",
            },
        ];
    }
    return [];
}

export const sqlEditorStatusContributor: WorkbenchStatusContributor = {
    id: "sql-editor-status",
    getItems: (context): WorkbenchStatusItemModel[] => {
        const tab = context.activeTab;
        const activeItems =
            tab?.type === "sql_editor"
                ? (() => {
                      const snapshot =
                          context.tabRuntimeState.sqlEditorByTabId[tab.id]
                              ?.activeExecution;
                      return snapshot
                          ? buildActiveExecutionItems(context, tab, snapshot)
                          : buildLegacyActiveTabItems(tab, context);
                  })()
                : [];
        return [...activeItems, ...buildBackgroundItems(context)];
    },
};
