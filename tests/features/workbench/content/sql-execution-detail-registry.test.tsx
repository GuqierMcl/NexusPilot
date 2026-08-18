import { expect, test } from "bun:test";

import {
    createSqlExecutionDetailContributorRegistry,
    sqlExecutionDetailContributorRegistry,
    type SqlExecutionDetailContext,
} from "../../../../src/features/workbench/content/components/sql-editor/execution-detail-contributor-registry";

test("global detail registry includes ClickHouse while isolated registries stay empty", () => {
    expect(
        sqlExecutionDetailContributorRegistry
            .resolve(detailContext("clickhouse"))
            .map((item) => item.id),
    ).toContain("clickhouse-execution-observation");
    expect(
        sqlExecutionDetailContributorRegistry.resolve(
            detailContext("postgres"),
        ),
    ).toEqual([]);
    expect(
        createSqlExecutionDetailContributorRegistry().resolve(
            detailContext("clickhouse"),
        ),
    ).toEqual([]);
});

test("detail registry selects contributors without a driver switch in the shell", () => {
    const registry = createSqlExecutionDetailContributorRegistry();
    registry.register({
        id: "fake",
        supports: (context) => context.driverName === "fake-db",
        render: (context) => <span>{context.snapshot.queryId}</span>,
    });

    expect(
        registry.resolve(detailContext("fake-db")).map((item) => item.id),
    ).toEqual(["fake"]);
    expect(registry.resolve(detailContext("other"))).toEqual([]);
});

test("detail registry rejects duplicate IDs and unregisters only its own instance", () => {
    const registry = createSqlExecutionDetailContributorRegistry();
    const first = {
        id: "fake",
        supports: () => true,
        render: () => <span>first</span>,
    };
    const unregister = registry.register(first);

    expect(() =>
        registry.register({
            id: "fake",
            supports: () => true,
            render: () => <span>duplicate</span>,
        }),
    ).toThrow();
    unregister();
    unregister();

    expect(registry.resolve(detailContext("fake-db"))).toEqual([]);
});

function detailContext(driverName: string): SqlExecutionDetailContext {
    return {
        uiTabId: "sql-tab",
        profileId: "profile-1",
        driverName,
        features: {
            managedLifecycle: true,
            statementAccess: "readOnly",
            activeCancel: false,
            liveProgress: true,
            querySummary: true,
            rawResult: false,
            configurableTimeout: true,
        },
        snapshot: {
            executionId: "execution-1",
            queryId: "query-1",
            tabId: "runtime-tab",
            state: "running",
            revision: 2,
            statementClass: "read",
            startedAt: 1,
            finishedAt: null,
            progressAvailable: true,
            summary: null,
            outcome: null,
            failure: null,
            cancelMessage: null,
        },
    };
}
