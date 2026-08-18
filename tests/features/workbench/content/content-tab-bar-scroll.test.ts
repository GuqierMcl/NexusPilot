import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const contentTabBarPath = join(
    import.meta.dir,
    "../../../../src/features/workbench/content/components/ContentTabBar.tsx",
);

async function readContentTabBarSource() {
    return await Bun.file(contentTabBarPath).text();
}

describe("ContentTabBar overflow scrolling", () => {
    test("uses a hover-only shadcn-style horizontal ScrollArea without increasing tab bar height", async () => {
        const source = await readContentTabBarSource();

        expect(source).toContain("ScrollAreaPrimitive.Root");
        expect(source).toContain('type="hover"');
        expect(source).toContain('orientation="horizontal"');
        expect(source).toContain("content-tab-scroll-area-viewport");
        expect(source).toContain('className="flex h-9 items-stretch border-b bg-muted/30"');
        expect(source).not.toContain('className="flex h-11 items-stretch border-b bg-muted/30"');
        expect(source).not.toContain("[&::-webkit-scrollbar]:hidden");
        expect(source).not.toContain("[scrollbar-width:none]");
    });
});
