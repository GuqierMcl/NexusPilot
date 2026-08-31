import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const treeNodePath = join(
    import.meta.dir,
    "../../src/features/workbench/explorer/components/ConnectionTreeNode.tsx",
);

async function readSource(path: string): Promise<string> {
    return (await Bun.file(path).text()).replace(/\r\n/g, "\n");
}

describe("connection hover card integration", () => {
    test("composes the preview with the existing context menu row", async () => {
        const source = await readSource(treeNodePath);

        expect(source).toContain("<HoverCard>");
        expect(source).toContain("<HoverCardTrigger");
        expect(source).toContain("delay={280}");
        expect(source).toContain("closeDelay={120}");
        expect(source).toContain("render={<ContextMenuTrigger render={rowRoot} />}");
        expect(source).toContain('side="right"');
        expect(source).toContain('align="start"');
        expect(source).toContain("sideOffset={8}");
        expect(source).toContain('className="w-80 p-0"');
        expect(source).toContain("<ContextMenu>");
        expect(source).toContain("<ContextMenuContent>");
    });

    test("keeps the hover composition inside the existing drag shell boundary", async () => {
        const source = await readSource(treeNodePath);

        const hoverRowIndex = source.indexOf("const hoverRenderedRow");
        const shellIndex = source.indexOf("const renderedRow = renderRowShell");
        const shellInvocationIndex = source.indexOf(
            "renderRowShell(node, depth, hoverRenderedRow)",
        );

        expect(hoverRowIndex).toBeGreaterThan(-1);
        expect(shellIndex).toBeGreaterThan(hoverRowIndex);
        expect(shellInvocationIndex).toBeGreaterThan(shellIndex);
        expect(source).toContain('role="button"');
        expect(source).toContain("onClick={handleClick}");
        expect(source).toContain("onDoubleClick={() => void handleDoubleClick()}");
        expect(source).toContain("onKeyDown={handleMainActionKeyDown}");
    });
});
