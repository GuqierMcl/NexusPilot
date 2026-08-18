import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const statusBarPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/status-bar/WorkbenchStatusBar.tsx",
);
const statusItemPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/status-bar/components/StatusBarItem.tsx",
);
const statusItemsHookPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/status-bar/hooks/useWorkbenchStatusItems.ts",
);
const typesPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/status-bar/types.ts",
);
const workbenchContentPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/content/WorkbenchContentPanel.tsx",
);

async function readSource(path: string) {
    return (await Bun.file(path).text()).replace(/\r\n/g, "\n");
}

describe("WorkbenchStatusBar shell structure", () => {
    test("renders item models instead of fixed business status components", async () => {
        const source = await readSource(statusBarPath);

        expect(source).toContain("useWorkbenchStatusItems");
        expect(source).not.toContain("ConnectionStatusItem");
        expect(source).not.toContain("DatabaseContextItem");
        expect(source).not.toContain("QueryStatusItem");
        expect(source).not.toContain("AgentStatusItem");
        expect(source).not.toContain("ModelStatusItem");
    });

    test("public shell, hook, and types do not expose a center status area", async () => {
        const combined = [
            await readSource(statusBarPath),
            await readSource(statusItemsHookPath),
            await readSource(typesPath),
        ].join("\n");

        expect(combined).not.toContain('"center"');
        expect(combined).not.toContain("items.center");
        expect(combined).not.toContain("center:");
        expect(combined).not.toContain("justify-center");
    });

    test("public shell and hook do not enumerate concrete tab types", async () => {
        const combined = [
            await readSource(statusBarPath),
            await readSource(statusItemsHookPath),
        ].join("\n");

        for (const token of [
            "clickhouse",
            "driverName ===",
            "cancelSqlExecution",
            "executeSqlLifecycle",
            "sql_editor",
            "table_data",
            "key_value",
            "table_design",
            "json_viewer",
            "graph_topology",
            "dashboard",
            "tab.type ===",
            "switch (",
        ]) {
            expect(combined).not.toContain(token);
        }
    });

    test("status items support width strategies without fixed max width", async () => {
        const source = await readSource(statusItemPath);

        expect(source).toContain("width = \"content\"");
        expect(source).toContain("getWidthClassName");
        expect(source).toContain("cursor-default");
        expect(source).toContain("cursor-pointer");
        expect(source).not.toContain("max-w-64");
    });

    test("content shell mounts only the generic status overlay host", async () => {
        const workbenchContentSource = await readSource(
            workbenchContentPath,
        );
        const statusBarSource = await readSource(statusBarPath);

        expect(workbenchContentSource).toContain(
            "WorkbenchStatusOverlayHost",
        );
        expect(workbenchContentSource).not.toContain(
            "ExecutionOverviewDrawer",
        );
        expect(workbenchContentSource).not.toContain("sql_editor");
        expect(statusBarSource).not.toContain("ExecutionOverviewDrawer");
    });

    test("status items provide an info tone aligned with table transaction blue", async () => {
        const source = await readSource(statusItemPath);

        expect(source).toContain('case "info"');
        expect(source).toContain("text-sky-600");
        expect(source).toContain("dark:text-sky-300");
    });

    test("status item model supports rich tooltip content and mouse events", async () => {
        const types = await readSource(typesPath);

        expect(types).toContain("tooltipContent?: React.ReactNode");
        expect(types).toContain("onMouseEnter?: () => void");
        expect(types).toContain("onMouseLeave?: () => void");
        expect(types).toContain("title?: string");
    });

    test("status bar shell forwards rich tooltip content and mouse events", async () => {
        const source = await readSource(statusBarPath);

        expect(source).toContain("tooltipContent={item.tooltipContent}");
        expect(source).toContain("onMouseEnter={item.onMouseEnter}");
        expect(source).toContain("onMouseLeave={item.onMouseLeave}");
    });

    test("StatusBarItem renders rich tooltip with fallback to title and label", async () => {
        const source = await readSource(statusItemPath);

        expect(source).toContain("tooltipContent ?? title ?? label");
        expect(source).toContain('"aria-label": title ?? label');
        expect(source).toContain("hasRichTooltip");
    });

    test("non-interactive status items keep hover highlight without pointer cursor", async () => {
        const source = await readSource(statusItemPath);

        const hoverLine = source
            .split("\n")
            .find((line: string) => line.includes("hover:bg-muted"));
        expect(hoverLine).toBeTruthy();
        expect(hoverLine).not.toContain("cursor-pointer");
        expect(hoverLine).not.toContain("isInteractive");
    });
});
