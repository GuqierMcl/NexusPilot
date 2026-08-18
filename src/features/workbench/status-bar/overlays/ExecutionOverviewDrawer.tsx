import { useEffect, useMemo, type FC } from "react";

import { Button } from "@/components/ui/button";
import {
    Drawer,
    DrawerContent,
    DrawerDescription,
    DrawerHeader,
    DrawerTitle,
} from "@/components/ui/drawer";
import {
    useTabRuntimeStateStore,
    useWorkbenchStatusOverlayStore,
    useWorkbenchTabsStore,
    type SqlEditorRuntimeState,
    type WorkbenchTab,
} from "@/store";
import type {
    SqlExecutionSnapshot,
    SqlExecutionState,
} from "@/types/ipc";

const STATE_LABELS: Record<SqlExecutionState, string> = {
    queued: "准备执行",
    starting: "准备执行",
    running: "正在执行",
    canceling: "正在取消",
    succeeded: "查询已完成",
    failed: "查询失败",
    timedOut: "查询超时",
    canceled: "查询已取消",
    cancelFailed: "取消未确认",
};

export interface ExecutionOverviewItemModel {
    tabId: string;
    title: string;
    stateLabel: string;
    statementClass: string;
    elapsedLabel: string;
}

export interface ExecutionOverviewModel {
    items: ExecutionOverviewItemModel[];
}

export interface ExecutionOverviewModelInput {
    requestedTabIds: string[];
    tabs: WorkbenchTab[];
    sqlEditorByTabId: Record<string, SqlEditorRuntimeState>;
    nowMs?: number;
}

function formatElapsed(
    snapshot: SqlExecutionSnapshot,
    nowMs: number,
): string {
    const elapsedMs = Math.max(
        0,
        (snapshot.finishedAt ?? nowMs) - snapshot.startedAt,
    );
    return elapsedMs < 1_000
        ? `${elapsedMs}ms`
        : `${(elapsedMs / 1_000).toFixed(1)}s`;
}

export function buildExecutionOverviewModel({
    requestedTabIds,
    tabs,
    sqlEditorByTabId,
    nowMs = Date.now(),
}: ExecutionOverviewModelInput): ExecutionOverviewModel {
    const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
    const items = [...new Set(requestedTabIds)].flatMap((tabId) => {
        const tab = tabsById.get(tabId);
        if (!tab || tab.type !== "sql_editor") return [];
        const snapshot = sqlEditorByTabId[tabId]?.activeExecution;
        if (!snapshot) return [];
        return [
            {
                tabId,
                title: tab.title,
                stateLabel: STATE_LABELS[snapshot.state],
                statementClass: snapshot.statementClass.toUpperCase(),
                elapsedLabel: formatElapsed(snapshot, nowMs),
            },
        ];
    });
    return { items };
}

export const ExecutionOverviewDrawer: FC = () => {
    const requestedTabIds = useWorkbenchStatusOverlayStore(
        (state) => state.executionOverviewTabIds,
    );
    const closeExecutionOverview = useWorkbenchStatusOverlayStore(
        (state) => state.closeExecutionOverview,
    );
    const tabs = useWorkbenchTabsStore((state) => state.tabs);
    const activateTab = useWorkbenchTabsStore((state) => state.activateTab);
    const sqlEditorByTabId = useTabRuntimeStateStore(
        (state) => state.sqlEditorByTabId,
    );
    const patchSqlEditorState = useTabRuntimeStateStore(
        (state) => state.patchSqlEditorState,
    );
    const model = useMemo(
        () =>
            buildExecutionOverviewModel({
                requestedTabIds: requestedTabIds ?? [],
                tabs,
                sqlEditorByTabId,
            }),
        [requestedTabIds, sqlEditorByTabId, tabs],
    );

    useEffect(() => {
        if (requestedTabIds && model.items.length === 0) {
            closeExecutionOverview();
        }
    }, [closeExecutionOverview, model.items.length, requestedTabIds]);

    const openDetails = (tabId: string): void => {
        activateTab(tabId);
        patchSqlEditorState(tabId, { executionDetailOpen: true });
        closeExecutionOverview();
    };

    return (
        <Drawer
            open={requestedTabIds != null}
            onOpenChange={(open) => {
                if (!open) closeExecutionOverview();
            }}
            direction="right"
        >
            <DrawerContent className="sm:max-w-md">
                <DrawerHeader>
                    <DrawerTitle>后台执行概览</DrawerTitle>
                    <DrawerDescription>
                        选择一个查询以聚焦标签页并打开执行详情
                    </DrawerDescription>
                </DrawerHeader>
                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-4">
                    {model.items.map((item) => (
                        <Button
                            key={item.tabId}
                            type="button"
                            variant="ghost"
                            className="h-auto w-full justify-start px-3 py-2 text-left"
                            onClick={() => openDetails(item.tabId)}
                        >
                            <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                                <span className="w-full truncate font-medium">
                                    {item.title}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {item.stateLabel} · {item.statementClass} · {item.elapsedLabel}
                                </span>
                            </span>
                        </Button>
                    ))}
                </div>
            </DrawerContent>
        </Drawer>
    );
};
