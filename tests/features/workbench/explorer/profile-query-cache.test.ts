import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { clearProfileQueryCache } from "../../../../src/features/workbench/explorer/profile-query-cache";
import {
    clickHouseViewMutationInvalidationKeys,
    queryKeys,
} from "../../../../src/lib/query-keys";

test("explicit disconnect removes only the owning profile query cache", async () => {
    const queryClient = new QueryClient();
    const profileOne = queryKeys.containers("profile-1", null);
    const profileTwo = queryKeys.containers("profile-2", null);
    queryClient.setQueryData(profileOne, ["cached-profile-1"]);
    queryClient.setQueryData(profileTwo, ["cached-profile-2"]);

    await clearProfileQueryCache(queryClient, "profile-1");

    expect(queryClient.getQueryData(profileOne)).toBeUndefined();
    expect(queryClient.getQueryData(profileTwo)).toEqual(["cached-profile-2"]);
});

test("ClickHouse View query keys isolate owner scope family object and cluster revision", () => {
    const container = {
        kind: "materialized_view" as const,
        database: "analytics",
        table: "events_mv",
    };
    const first = queryKeys.clickHouseViewDesign(
        "profile-1",
        null,
        "cluster",
        "refreshable_materialized",
        container,
        "topology-v1",
    );
    const second = queryKeys.clickHouseViewDesign(
        "profile-1",
        "runtime-tab-1",
        "temporary",
        "temporary",
        { kind: "view", table: "session_view" },
        null,
    );

    expect(first).not.toEqual(second);
    expect(first).toContain("topology-v1");
    expect(second).toContain("runtime-tab-1");
    expect(
        queryKeys.clickHouseTemporaryViews("profile-1", "runtime-tab-1"),
    ).not.toEqual(
        queryKeys.clickHouseTemporaryViews("profile-1", "runtime-tab-2"),
    );
    expect(
        queryKeys.clickHouseViewSupport(
            "profile-1",
            null,
            "analytics",
            "topology-v1",
        ),
    ).not.toEqual(
        queryKeys.clickHouseViewSupport(
            "profile-2",
            null,
            "analytics",
            "topology-v1",
        ),
    );
});

test("View invalidation expands groups and data only for proven applied results", () => {
    const source = {
        kind: "view" as const,
        database: "analytics",
        table: "events_view",
    };
    const destination = { ...source, table: "events_view_v2" };
    const partial = clickHouseViewMutationInvalidationKeys({
        profileId: "profile-1",
        ownerTabRuntimeId: null,
        scope: "local",
        family: "normal",
        clusterRevision: null,
        source,
        destination,
        status: "partiallyApplied",
    });
    const applied = clickHouseViewMutationInvalidationKeys({
        profileId: "profile-1",
        ownerTabRuntimeId: null,
        scope: "local",
        family: "normal",
        clusterRevision: null,
        source,
        destination,
        status: "applied",
    });

    expect(partial).toContainEqual(
        queryKeys.clickHouseViewDesign(
            "profile-1",
            null,
            "local",
            "normal",
            source,
            null,
        ),
    );
    expect(applied.length).toBeGreaterThan(partial.length);
    expect(applied).toContainEqual(
        queryKeys.clickHouseViewDependencies("profile-1", destination),
    );
});
