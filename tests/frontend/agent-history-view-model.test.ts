import { describe, expect, test } from "bun:test";

import {
    canSwitchToAgentHistoryItem,
    createAgentHistoryItems,
    formatAgentHistoryTimestamp,
    getAgentChatTitle,
    readAgentHistoryRuntimeStatus,
} from "../../src/features/workbench/agent/history";

describe("agent history view model", () => {
    test("maps assistant-ui thread items into display rows", () => {
        const rows = createAgentHistoryItems({
            mainThreadId: "conv_active",
            currentThreadIsRunning: false,
            threadItems: [
                {
                    id: "thread_active",
                    remoteId: "conv_active",
                    title: "SQL 优化讨论",
                    status: "regular",
                    custom: {
                        runtimeStatus: { type: "busy", runId: "run_active" },
                        activeRunId: "run_active",
                        time: {
                            created: 1000,
                            updated: 2000,
                        },
                    },
                },
            {
                id: "thread_idle",
                remoteId: "conv_idle",
                title: "",
                status: "regular",
                    custom: {
                        runtimeStatus: { type: "idle" },
                        time: {
                            created: 3000,
                            updated: 4000,
                        },
                    },
                },
            ],
        });

        expect(rows).toEqual([
            {
                id: "thread_idle",
                remoteId: "conv_idle",
                title: "新对话",
                statusLabel: "空闲",
                updatedAtLabel: expect.any(String),
                active: false,
                disabled: false,
                archived: false,
                pinned: false,
                pinnedAt: null,
                runtimeStatusType: "idle",
                activeRunId: null,
                canInterrupt: false,
            },
            {
                id: "thread_active",
                remoteId: "conv_active",
                title: "SQL 优化讨论",
                statusLabel: "运行中",
                updatedAtLabel: expect.any(String),
                active: true,
                disabled: false,
                archived: false,
                pinned: false,
                pinnedAt: null,
                runtimeStatusType: "busy",
                activeRunId: "run_active",
                canInterrupt: true,
            },
        ]);
    });

    test("omits local assistant-ui threads from the Runtime history list", () => {
        const rows = createAgentHistoryItems({
            mainThreadId: "__LOCALID_current",
            currentThreadIsRunning: false,
            threadItems: [
                {
                    id: "__LOCALID_current",
                    title: "",
                    status: "new",
                    custom: null,
                },
                {
                    id: "__LOCALID_initialized",
                    remoteId: "__LOCALID_initialized",
                    title: "",
                    status: "regular",
                    custom: {},
                },
                {
                    id: "conv_persisted",
                    remoteId: "conv_persisted",
                    title: "已保存会话",
                    status: "regular",
                    custom: {
                        runtimeStatus: { type: "idle" },
                        time: { created: 1, updated: 2 },
                    },
                },
            ],
        });

        expect(rows.map((row) => row.id)).toEqual(["conv_persisted"]);
    });

    test("sorts Runtime history rows by latest Runtime update time", () => {
        const rows = createAgentHistoryItems({
            mainThreadId: "thread_old",
            currentThreadIsRunning: false,
            threadItems: [
                {
                    id: "thread_old",
                    remoteId: "conv_old",
                    title: "旧会话",
                    custom: {
                        runtimeStatus: { type: "idle" },
                        time: { created: 1, updated: 100 },
                    },
                },
                {
                    id: "thread_unknown_time",
                    remoteId: "conv_unknown_time",
                    title: "未知时间",
                    custom: {
                        runtimeStatus: { type: "idle" },
                    },
                },
                {
                    id: "thread_new",
                    remoteId: "conv_new",
                    title: "新会话",
                    custom: {
                        runtimeStatus: { type: "idle" },
                        time: { created: 2, updated: 300 },
                    },
                },
                {
                    id: "thread_middle",
                    remoteId: "conv_middle",
                    title: "中间会话",
                    custom: {
                        runtimeStatus: { type: "idle" },
                        time: { created: 3, updated: 200 },
                    },
                },
            ],
        });

        expect(rows.map((row) => row.id)).toEqual([
            "thread_new",
            "thread_middle",
            "thread_old",
            "thread_unknown_time",
        ]);
    });

    test("disables switching to other conversations while current thread is running", () => {
        const rows = createAgentHistoryItems({
            mainThreadId: "thread_current",
            currentThreadIsRunning: true,
            threadItems: [
                {
                    id: "thread_current",
                    remoteId: "conv_current",
                    title: "当前会话",
                    status: "regular",
                    custom: {
                        runtimeStatus: { type: "busy" },
                        time: { created: 1, updated: 2 },
                    },
                },
                {
                    id: "thread_other",
                    remoteId: "conv_other",
                    title: "历史会话",
                    status: "regular",
                    custom: {
                        runtimeStatus: { type: "idle" },
                        time: { created: 3, updated: 4 },
                    },
                },
            ],
        });

        expect(rows.map((row) => ({ id: row.id, disabled: row.disabled }))).toEqual([
            { id: "thread_other", disabled: true },
            { id: "thread_current", disabled: false },
        ]);
        expect(canSwitchToAgentHistoryItem(rows[0]!)).toBe(false);
        expect(canSwitchToAgentHistoryItem(rows[1]!)).toBe(true);
    });

    test("reads stable runtime status labels", () => {
        expect(readAgentHistoryRuntimeStatus({ type: "idle" })).toEqual({
            type: "idle",
            label: "空闲",
        });
        expect(readAgentHistoryRuntimeStatus({ type: "busy", runId: "run_1" })).toEqual({
            type: "busy",
            label: "运行中",
        });
        expect(readAgentHistoryRuntimeStatus({ type: "error" })).toEqual({
            type: "error",
            label: "错误",
        });
        expect(readAgentHistoryRuntimeStatus({ type: "archived" })).toEqual({
            type: "archived",
            label: "已归档",
        });
        expect(readAgentHistoryRuntimeStatus({ type: "interrupted" })).toEqual({
            type: "interrupted",
            label: "已中断",
        });
        expect(readAgentHistoryRuntimeStatus({ unexpected: true })).toEqual({
            type: "unknown",
            label: "未知",
        });
    });

    test("marks busy runtime conversations as interruptible when active run id exists", () => {
        const rows = createAgentHistoryItems({
            mainThreadId: "thread_busy",
            currentThreadIsRunning: false,
            threadItems: [
                {
                    id: "thread_busy",
                    remoteId: "conv_busy",
                    title: "运行中会话",
                    custom: {
                        runtimeStatus: { type: "busy", runId: "run_busy" },
                        activeRunId: "run_busy",
                        time: { created: 1, updated: 2 },
                    },
                },
            ],
        });

        expect(rows[0]).toMatchObject({
            activeRunId: "run_busy",
            canInterrupt: true,
        });
    });

    test("formats timestamps without throwing on invalid values", () => {
        expect(formatAgentHistoryTimestamp(1_700_000_000_000)).toContain("2023");
        expect(formatAgentHistoryTimestamp(undefined)).toBe("未知时间");
        expect(formatAgentHistoryTimestamp(Number.NaN)).toBe("未知时间");
    });

    test("uses the current real thread title in chat mode", () => {
        expect(getAgentChatTitle({ title: " SQL 优化讨论 " })).toBe("SQL 优化讨论");
        expect(getAgentChatTitle({ title: "" })).toBe("");
        expect(getAgentChatTitle(null)).toBe("");
    });
});
