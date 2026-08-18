import { useEffect } from "react";
import {
    Clock3,
    FileOutput,
    FilePlus2,
    ListStart,
    OctagonMinus,
    PanelBottomClose,
    PanelBottomOpen,
    Play,
    Save,
    Square,
} from "lucide-react";

import {
    useContentToolbarStore,
    type ContentToolbarAction,
    type SqlExecutionTimeoutMs,
} from "@/store";
import type { SqlExecutionState } from "@/types/ipc";

import { getSqlEditorResultPanelToggleActionState } from "./sql-editor-utils";
import { buildClickHouseSessionViewsAction } from "./clickhouse-session-views-contributor";

interface UseSqlEditorToolbarOptions {
    tabId: string;
    driverName: string;
    isExecuting: boolean;
    isSaving: boolean;
    canSave: boolean;
    runTitle: string;
    canRunScript: boolean;
    canRunSelection: boolean;
    canRunCurrentStatement: boolean;
    runScriptTitle: string;
    runSelectionTitle: string;
    runCurrentStatementTitle: string;
    isScriptExecuting: boolean;
    canStopScript: boolean;
    managedLifecycle: boolean;
    activeCancel: boolean;
    rawResult: boolean;
    configurableTimeout: boolean;
    timeoutMs: SqlExecutionTimeoutMs;
    executionState: SqlExecutionState | null;
    resultPanelCollapsed: boolean;
    onRun: () => void;
    onRunScript: () => void;
    onRunSelection: () => void;
    onRunCurrentStatement: () => void;
    onStopScript: () => void;
    onCancelActive: () => void;
    onRunRaw: () => void;
    onTimeoutChange: (value: SqlExecutionTimeoutMs) => void;
    onSave: () => void;
    onNew: () => void;
    onToggleResultPanel: () => void;
    onOpenSessionViews: () => void;
}

export const SQL_EXECUTION_TIMEOUT_OPTIONS = [
    { value: 30_000, label: "30 秒" },
    { value: 60_000, label: "1 分钟" },
    { value: 300_000, label: "5 分钟" },
    { value: 900_000, label: "15 分钟" },
    { value: 3_600_000, label: "1 小时" },
    { value: null, label: "无执行超时" },
] as const satisfies ReadonlyArray<{
    value: SqlExecutionTimeoutMs;
    label: string;
}>;

export function buildSqlExecutionTimeoutAction(params: {
    configurableTimeout: boolean;
    timeoutMs: SqlExecutionTimeoutMs;
    disabled: boolean;
    onTimeoutChange(value: SqlExecutionTimeoutMs): void;
}): ContentToolbarAction | null {
    if (!params.configurableTimeout) return null;
    const current = SQL_EXECUTION_TIMEOUT_OPTIONS.find(
        (option) => option.value === params.timeoutMs,
    );
    return {
        id: "executionTimeout",
        icon: Clock3,
        label: "执行超时",
        title: `执行超时：${current?.label ?? "30 秒"}`,
        disabled: params.disabled,
        menuItems: SQL_EXECUTION_TIMEOUT_OPTIONS.map((option) => ({
            id: `executionTimeout-${option.value ?? "none"}`,
            label: option.label,
            title: `将当前标签页执行超时设置为${option.label}`,
            onClick: () => params.onTimeoutChange(option.value),
        })),
    };
}

export interface SqlExecutionCancelActionInput {
    managedLifecycle: boolean;
    activeCancel: boolean;
    state: SqlExecutionState | null;
    onCancelActive(): void;
}

export function buildSqlExecutionCancelAction({
    managedLifecycle,
    activeCancel,
    state,
    onCancelActive,
}: SqlExecutionCancelActionInput): ContentToolbarAction | null {
    if (
        !managedLifecycle ||
        !activeCancel ||
        state == null ||
        (state !== "starting" &&
            state !== "running" &&
            state !== "canceling")
    ) {
        return null;
    }
    const canceling = state === "canceling";
    return {
        id: "cancelActiveExecution",
        icon: Square,
        label: canceling ? "正在取消" : "取消查询",
        title: canceling
            ? "正在等待数据库确认查询终止"
            : "取消当前活动查询；已发生的服务端副作用不会自动回滚",
        disabled: canceling,
        onClick: onCancelActive,
    };
}

export function buildSqlExecutionRawAction(params: {
    managedLifecycle: boolean;
    rawResult: boolean;
    disabled: boolean;
    onRunRaw(): void;
}): ContentToolbarAction | null {
    if (!params.managedLifecycle || !params.rawResult) return null;
    return {
        id: "runRaw",
        icon: FileOutput,
        label: "运行原始结果",
        title: "将单条 SQL 作为原始字节结果运行；不会改变默认 Grid 模式",
        disabled: params.disabled,
        onClick: params.onRunRaw,
    };
}

export function useSqlEditorToolbar({
    tabId,
    driverName,
    isExecuting,
    isSaving,
    canSave,
    runTitle,
    canRunScript,
    canRunSelection,
    canRunCurrentStatement,
    runScriptTitle,
    runSelectionTitle,
    runCurrentStatementTitle,
    isScriptExecuting,
    canStopScript,
    managedLifecycle,
    activeCancel,
    rawResult,
    configurableTimeout,
    timeoutMs,
    executionState,
    resultPanelCollapsed,
    onRun,
    onRunScript,
    onRunSelection,
    onRunCurrentStatement,
    onStopScript,
    onCancelActive,
    onRunRaw,
    onTimeoutChange,
    onSave,
    onNew,
    onToggleResultPanel,
    onOpenSessionViews,
}: UseSqlEditorToolbarOptions) {
    const setToolbar = useContentToolbarStore((state) => state.setToolbar);
    const clearToolbar = useContentToolbarStore((state) => state.clearToolbar);

    useEffect(() => {
        const resultPanelToggleAction =
            getSqlEditorResultPanelToggleActionState({
                collapsed: resultPanelCollapsed,
            });
        const ResultPanelIcon =
            resultPanelToggleAction.icon === "resultPanelOpen"
                ? PanelBottomOpen
                : PanelBottomClose;
        const cancelActiveAction = buildSqlExecutionCancelAction({
            managedLifecycle,
            activeCancel,
            state: executionState,
            onCancelActive,
        });
        const timeoutAction = buildSqlExecutionTimeoutAction({
            configurableTimeout,
            timeoutMs,
            disabled: isExecuting || isScriptExecuting,
            onTimeoutChange,
        });
        const rawAction = buildSqlExecutionRawAction({
            managedLifecycle,
            rawResult,
            disabled: isExecuting || isScriptExecuting,
            onRunRaw,
        });
        const sessionViewsAction = buildClickHouseSessionViewsAction({
            driverName,
            disabled: isExecuting || isScriptExecuting,
            onOpen: onOpenSessionViews,
        });
        const actions: ContentToolbarAction[] = [
            {
                id: "run",
                icon: Play,
                label: "运行",
                title: runTitle,
                variant: "default",
                disabled: isExecuting || isScriptExecuting,
                onClick: onRun,
                menuItems: [
                    {
                        id: "runScript",
                        icon: ListStart,
                        label: "运行全部",
                        title: runScriptTitle,
                        disabled:
                            isExecuting || isScriptExecuting || !canRunScript,
                        onClick: onRunScript,
                    },
                    {
                        id: "runSelection",
                        icon: Play,
                        label: "运行已选取 SQL",
                        title: runSelectionTitle,
                        disabled:
                            isExecuting ||
                            isScriptExecuting ||
                            !canRunSelection,
                        onClick: onRunSelection,
                    },
                    {
                        id: "runCurrentStatement",
                        icon: Play,
                        label: "运行当前语句",
                        title: runCurrentStatementTitle,
                        disabled:
                            isExecuting ||
                            isScriptExecuting ||
                            !canRunCurrentStatement,
                        onClick: onRunCurrentStatement,
                    },
                    ...(rawAction ? [rawAction] : []),
                ],
            },
            ...(cancelActiveAction ? [cancelActiveAction] : []),
            ...(canStopScript
                ? [
                      {
                          id: "stopScript",
                          icon: OctagonMinus,
                          label: "停止队列",
                          title: "当前 SQL 完成后停止后续队列，不会取消正在执行的 SQL",
                          disabled: !canStopScript,
                          onClick: onStopScript,
                      } satisfies ContentToolbarAction,
                  ]
                : []),
            ...(timeoutAction ? [timeoutAction] : []),
            ...(sessionViewsAction ? [sessionViewsAction] : []),
            {
                id: "save",
                icon: Save,
                label: "保存",
                title: "保存查询",
                disabled: isSaving || !canSave,
                onClick: onSave,
            },
            {
                id: "new",
                icon: FilePlus2,
                label: "新建",
                title: "新建查询",
                disabled: isExecuting || isScriptExecuting,
                onClick: onNew,
            },
            {
                id: "toggleResultPanel",
                icon: ResultPanelIcon,
                label: resultPanelToggleAction.label,
                title: resultPanelToggleAction.title,
                pressed: resultPanelToggleAction.pressed,
                onClick: onToggleResultPanel,
            },
        ];

        setToolbar(tabId, {
            actions,
            context: {
                icon: Play,
                label: "查询编辑器",
            },
        });
        return () => clearToolbar(tabId);
    }, [
        canSave,
        canRunScript,
        canRunSelection,
        canRunCurrentStatement,
        canStopScript,
        activeCancel,
        configurableTimeout,
        driverName,
        clearToolbar,
        executionState,
        isExecuting,
        isScriptExecuting,
        isSaving,
        managedLifecycle,
        rawResult,
        onCancelActive,
        onNew,
        onRun,
        onRunRaw,
        onRunScript,
        onRunSelection,
        onRunCurrentStatement,
        onSave,
        onStopScript,
        onTimeoutChange,
        onToggleResultPanel,
        onOpenSessionViews,
        resultPanelCollapsed,
        runCurrentStatementTitle,
        runScriptTitle,
        runSelectionTitle,
        runTitle,
        setToolbar,
        tabId,
        timeoutMs,
    ]);
}
