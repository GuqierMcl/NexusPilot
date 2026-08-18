import { expect, test } from "bun:test";
import { RefreshCw, Table2 } from "lucide-react";

import { useContentToolbarStore } from "../../src/store/slices/content-toolbar-slice";

test("stores and clears a full toolbar model per tab", () => {
    const store = useContentToolbarStore.getState();
    store.clearToolbar("tab-a");

    store.setToolbar("tab-a", {
        actions: [
            {
                id: "refresh",
                icon: RefreshCw,
                label: "刷新",
                title: "刷新当前数据",
                onClick: () => undefined,
            },
        ],
        context: {
            icon: Table2,
            label: "users | app",
        },
        emptyText: "当前标签页没有可用操作",
    });

    const saved = useContentToolbarStore.getState().modelsByTabId["tab-a"];
    expect(saved?.actions).toHaveLength(1);
    expect(saved?.actions[0]?.icon).toBe(RefreshCw);
    expect(saved?.context?.icon).toBe(Table2);
    expect(saved?.context?.label).toBe("users | app");

    useContentToolbarStore.getState().clearToolbar("tab-a");
    expect(
        useContentToolbarStore.getState().modelsByTabId["tab-a"],
    ).toBeUndefined();
});
