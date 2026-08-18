import { describe, expect, test } from "bun:test";

import {
    buildClickHouseViewDesignTabOpenRequest,
    buildSqlEditorTabOpenRequest,
    contentTabOwnsBackendRuntime,
    createWorkbenchTabFromOpenRequest,
    expandContentTabClosingSet,
    getContentTabOwnerId,
} from "../../../../src/features/workbench/content/content-tab-lifecycle-registry";
import { buildClickHouseSessionViewsAction } from "../../../../src/features/workbench/content/components/sql-editor/clickhouse-session-views-contributor";
import type { ConnectionRuntimeInfo } from "../../../../src/types/ipc";

function runtime(driverName: string): ConnectionRuntimeInfo {
    return {
        profileId: "profile-1",
        driverName,
        capabilities: {
            schemaBrowser: true,
            schemaMutator: false,
            dataTableBrowser: true,
            tableRowMutator: false,
            tableRowInserter: false,
            transactionManager: false,
            sqlExecutor: true,
            keyValueBrowser: false,
            graphQueryer: false,
            vectorSearcher: false,
        },
    };
}

describe("ClickHouse Temporary View dependent tabs", () => {
    test("Session Views contributes only to a ClickHouse SQL Editor runtime", () => {
        const action = buildClickHouseSessionViewsAction({
            driverName: "clickhouse",
            disabled: false,
            onOpen: () => undefined,
        });
        expect(action?.id).toBe("clickhouse.sessionViews");
        expect(
            buildClickHouseSessionViewsAction({
                driverName: "postgres",
                disabled: false,
                onOpen: () => undefined,
            }),
        ).toBeNull();
    });

    test("dependent ownership closes with the owner without owning another backend runtime", () => {
        const ownerRequest = buildSqlEditorTabOpenRequest("profile-1", {
            runtime: runtime("clickhouse"),
            tabId: "sql-owner-1",
        });
        const owner = createWorkbenchTabFromOpenRequest(ownerRequest);
        const dependent = createWorkbenchTabFromOpenRequest(
            buildClickHouseViewDesignTabOpenRequest("profile-1", {
                mode: "temporary",
                ownerTabRuntimeId: owner.id,
            }),
        );
        dependent.isDirty = true;

        expect(getContentTabOwnerId(dependent)).toBe(owner.id);
        expect(contentTabOwnsBackendRuntime(owner)).toBe(true);
        expect(contentTabOwnsBackendRuntime(dependent)).toBe(false);
        expect(
            expandContentTabClosingSet([owner, dependent], [owner.id]).map(
                (tab) => tab.id,
            ),
        ).toEqual([owner.id, dependent.id]);
        expect(
            expandContentTabClosingSet([owner, dependent], [dependent.id]).map(
                (tab) => tab.id,
            ),
        ).toEqual([dependent.id]);
    });
});
