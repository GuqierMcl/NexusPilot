import { expect, mock, test } from "bun:test";

import {
    buildSqlExecutionCancelAction,
    buildSqlExecutionRawAction,
    buildSqlExecutionTimeoutAction,
    SQL_EXECUTION_TIMEOUT_OPTIONS,
} from "../../../../src/features/workbench/content/components/sql-editor/useSqlEditorToolbar";

test("Raw action is capability-driven and invokes only its explicit handler", () => {
    const onRunRaw = mock(() => undefined);
    const action = buildSqlExecutionRawAction({
        managedLifecycle: true,
        rawResult: true,
        disabled: false,
        onRunRaw,
    });

    expect(action?.id).toBe("runRaw");
    expect(action?.label).toBe("运行原始结果");
    expect(action?.disabled).toBe(false);
    action?.onClick?.();
    expect(onRunRaw).toHaveBeenCalledTimes(1);

    for (const input of [
        { managedLifecycle: false, rawResult: true },
        { managedLifecycle: true, rawResult: false },
    ]) {
        expect(
            buildSqlExecutionRawAction({
                ...input,
                disabled: false,
                onRunRaw,
            }),
        ).toBeNull();
    }
});

test("timeout menu exposes the production allowlist and patches one tab value", () => {
    expect(SQL_EXECUTION_TIMEOUT_OPTIONS).toEqual([
        { value: 30_000, label: "30 秒" },
        { value: 60_000, label: "1 分钟" },
        { value: 300_000, label: "5 分钟" },
        { value: 900_000, label: "15 分钟" },
        { value: 3_600_000, label: "1 小时" },
        { value: null, label: "无执行超时" },
    ]);

    const selected: Array<number | null> = [];
    const action = buildSqlExecutionTimeoutAction({
        configurableTimeout: true,
        timeoutMs: 30_000,
        disabled: false,
        onTimeoutChange: (value) => selected.push(value),
    });
    expect(action?.id).toBe("executionTimeout");
    expect(action?.title).toBe("执行超时：30 秒");
    action?.menuItems?.[5]?.onClick?.();
    expect(selected).toEqual([null]);
});

test("timeout menu is absent without the neutral capability", () => {
    expect(
        buildSqlExecutionTimeoutAction({
            configurableTimeout: false,
            timeoutMs: 30_000,
            disabled: false,
            onTimeoutChange: () => undefined,
        }),
    ).toBeNull();
});

test("shows Cancel Active only for an active cancel-capable managed execution", () => {
    const onCancelActive = mock(() => undefined);
    const running = buildSqlExecutionCancelAction({
        managedLifecycle: true,
        activeCancel: true,
        state: "running",
        onCancelActive,
    });

    expect(running?.id).toBe("cancelActiveExecution");
    expect(running?.label).toBe("取消查询");
    expect(running?.disabled).toBe(false);
    running?.onClick?.();
    expect(onCancelActive).toHaveBeenCalledTimes(1);

    for (const input of [
        {
            managedLifecycle: false,
            activeCancel: true,
            state: "running" as const,
        },
        {
            managedLifecycle: true,
            activeCancel: false,
            state: "running" as const,
        },
        {
            managedLifecycle: true,
            activeCancel: true,
            state: "succeeded" as const,
        },
    ]) {
        expect(
            buildSqlExecutionCancelAction({ ...input, onCancelActive }),
        ).toBeNull();
    }
});

test("canceling remains visible but disabled and is not Stop Queue", () => {
    const action = buildSqlExecutionCancelAction({
        managedLifecycle: true,
        activeCancel: true,
        state: "canceling",
        onCancelActive: () => undefined,
    });

    expect(action?.id).toBe("cancelActiveExecution");
    expect(action?.label).toBe("正在取消");
    expect(action?.disabled).toBe(true);
    expect(action?.id).not.toBe("stopScript");
});
