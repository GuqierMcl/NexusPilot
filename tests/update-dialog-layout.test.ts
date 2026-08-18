import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("update dialog layout", () => {
    test("does not duplicate current and latest version badges", () => {
        const source = readFileSync(
            "src/features/update/UpdateDialog.tsx",
            "utf8",
        );

        expect(source).toContain("发现新版本");
        expect(source).toContain("当前版本 {availableUpdateInfo.currentVersion}");
        expect(source).not.toContain("当前 {availableUpdateInfo.currentVersion}");
        expect(source).not.toContain("最新 {availableUpdateInfo.version}");
    });
});
