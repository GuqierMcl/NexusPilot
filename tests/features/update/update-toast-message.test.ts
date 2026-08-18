import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const updateControllerPath = join(
    import.meta.dir,
    "../../../src/features/update/use-update-controller.ts",
);

async function readUpdateControllerSource() {
    return await Bun.file(updateControllerPath).text();
}

describe("update toast message", () => {
    test("does not include release notes body in the startup update toast", async () => {
        const source = await readUpdateControllerSource();

        expect(source).toContain("toast.info(`发现新版本 ${update.version}`");
        expect(source).not.toContain("update.body?.trim()");
        expect(source).toContain("当前版本 ${update.currentVersion}");
        expect(source).toContain("点击查看完整更新日志");
    });
});
