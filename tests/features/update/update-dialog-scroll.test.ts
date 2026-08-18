import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const updateDialogPath = join(
    import.meta.dir,
    "../../../src/features/update/UpdateDialog.tsx",
);

async function readUpdateDialogSource() {
    return await Bun.file(updateDialogPath).text();
}

describe("UpdateDialog release notes scrolling", () => {
    test("constrains the ScrollArea viewport so long release notes can scroll", async () => {
        const source = await readUpdateDialogSource();

        expect(source).toContain("更新日志");
        expect(source).toContain("<ScrollArea");
        expect(source).toContain('type="auto"');
        expect(source).toContain(
            "[&>[data-slot=scroll-area-viewport]]:max-h-64",
        );
        expect(source).toContain("max-h-64");
    });
});
