import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const updateControllerPath = join(
    import.meta.dir,
    "../../../src/features/update/use-update-controller.ts",
);
const developmentMockUpdatePath = join(
    import.meta.dir,
    "../../../src/features/update/development-mock-update.ts",
);
const aboutPanelPath = join(
    import.meta.dir,
    "../../../src/features/settings/panels/AboutPanel.tsx",
);

async function readSource(path: string) {
    return await Bun.file(path).text();
}

describe("development update mock", () => {
    test("manual checks use a mock update only outside production", async () => {
        const controllerSource = await readSource(updateControllerPath);
        const mockSource = await readSource(developmentMockUpdatePath);

        expect(controllerSource).toContain(
            'import { createDevelopmentMockUpdate } from "./development-mock-update";',
        );
        expect(controllerSource).toContain("createDevelopmentMockUpdate()");
        expect(controllerSource).toContain('mode === "startup"');
        expect(controllerSource).toContain("!import.meta.env.PROD");
        expect(controllerSource).toContain("await fetchAvailableUpdate(mode)");
        expect(controllerSource).not.toContain("new Update({");
        expect(controllerSource).not.toContain("开发环境模拟更新，用于验证");

        expect(mockSource).toContain("export function createDevelopmentMockUpdate");
        expect(mockSource).toContain("new Update({");
        expect(mockSource).toContain("开发环境模拟更新，用于验证");
    });

    test("the settings update button stays clickable in development", async () => {
        const source = await readSource(aboutPanelPath);

        expect(source).not.toContain("disabled={!import.meta.env.PROD || isCheckingUpdate}");
        expect(source).not.toContain("仅生产环境启用");
        expect(source).toContain("disabled={isCheckingUpdate}");
    });
});
