import { describe, expect, test } from "bun:test";

import { cloudSyncStatusContributor } from "../../../../src/features/workbench/status-bar/contributors/cloud-sync-status-contributor";
import { Spinner } from "../../../../src/components/ui/spinner";
import type {
    CloudDesktopStateProjection,
    CloudSyncRuntimePhase,
} from "../../../../src/types/ipc";
import type { WorkbenchStatusContext } from "../../../../src/features/workbench/status-bar/types";

function context(
    phase: CloudSyncRuntimePhase,
    overrides: Partial<CloudDesktopStateProjection["runtime"]> = {},
): WorkbenchStatusContext {
    return {
        activeTab: null,
        tabs: [],
        connectionSessions: {},
        tabRuntimeState: {
            sqlEditorByTabId: {},
            tableDataByTabId: {},
            tableDesignByTabId: {},
            clickHouseTableDesignByTabId: {},
            clickHouseViewDesignByTabId: {},
            schemaDesignByTabId: {},
            keyValueByTabId: {},
        },
        layout: {
            leftSidebarCollapsed: false,
            rightSidebarCollapsed: false,
        },
        aiRuntime: {
            healthStatus: "unknown",
            isChecking: false,
            errorMessage: null,
        },
        agent: {
            composerSendBlocker: null,
        },
        cloud: {
            connection: "connected",
            context: null,
            capabilities: [],
            runtime: {
                phase,
                trigger: null,
                lastStartedAt: null,
                lastCompletedAt: null,
                lastSucceededAt: null,
                nextRetryAt: null,
                retryAttempt: 0,
                pendingOperations: 0,
                conflicts: 0,
                lastResult: null,
                lastErrorCode: null,
                ...overrides,
            },
            refresh: {
                inFlight: false,
                lastStartedAt: null,
                lastCompletedAt: null,
                lastSucceededAt: null,
                lastError: null,
            },
        },
        nowMs: 0,
        actions: {
            focusTab: () => undefined,
            openSqlExecutionDetails: () => undefined,
            openExecutionOverview: () => undefined,
        },
    };
}

describe("Cloud sync status contributor", () => {
    test("hides disabled and idle state without work", () => {
        expect(cloudSyncStatusContributor.getItems(context("disabled"))).toEqual([]);
        expect(cloudSyncStatusContributor.getItems(context("idle"))).toEqual([]);
    });

    test("shows pending operations using user-facing item wording", () => {
        const items = cloudSyncStatusContributor.getItems(
            context("idle", { pendingOperations: 1 }),
        );

        expect(items[0]).toMatchObject({
            id: "cloud-sync-status",
            label: "1 项待同步",
            tone: "warning",
            area: "right",
        });
        expect(items[0]?.label).not.toContain("资产");
        expect(items[0]?.onClick).toBeUndefined();
    });

    test("prioritizes conflicts over pending operation count", () => {
        const items = cloudSyncStatusContributor.getItems(
            context("conflicted", { pendingOperations: 3, conflicts: 1 }),
        );

        expect(items[0]).toMatchObject({
            label: "1 个冲突待解决",
            tone: "warning",
        });
    });

    test("exposes active and attention-required phases", () => {
        const cases: Array<[CloudSyncRuntimePhase, string, string]> = [
            ["syncing", "同步中", "info"],
            ["paused", "同步已暂停", "warning"],
            ["offline", "同步暂时离线", "warning"],
            ["read_only", "同步只读", "warning"],
            ["recovery_required", "同步需要恢复", "warning"],
            ["device_revoked", "本设备已撤销", "error"],
            ["quota_exceeded", "同步用量已达上限", "warning"],
            ["unavailable", "同步暂不可用", "error"],
        ];

        for (const [phase, label, tone] of cases) {
            const item = cloudSyncStatusContributor.getItems(context(phase))[0];
            expect(item).toMatchObject({
                label,
                tone,
                area: "right",
            });
            if (phase === "syncing") {
                expect(item?.icon).toBe(Spinner);
                expect(item?.iconClassName).toBeUndefined();
            }
        }
    });
});
