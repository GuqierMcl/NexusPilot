import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("website theme comparison hero preview", () => {
    test("uses the interactive screenshot comparison component in the homepage hero", () => {
        const heroSource = readFileSync(
            "sites/product/src/components/Hero.astro",
            "utf8",
        );

        expect(heroSource).toContain(
            'import { ThemeComparisonSlider } from "./ThemeComparisonSlider";',
        );
        expect(heroSource).toContain("<ThemeComparisonSlider client:load />");
        expect(heroSource).not.toContain("window-chrome");
        expect(heroSource).not.toContain("Simulated workbench layout");
    });

    test("keeps the supplied light and dark screenshots as public website assets", () => {
        expect(
            existsSync(
                "sites/product/public/screenshots/nexuspilot-workbench-light.png",
            ),
        ).toBe(true);
        expect(
            existsSync(
                "sites/product/public/screenshots/nexuspilot-workbench-dark.png",
            ),
        ).toBe(true);
    });

    test("exposes an accessible draggable range control for the comparison boundary", () => {
        const componentPath =
            "sites/product/src/components/ThemeComparisonSlider.tsx";

        expect(existsSync(componentPath)).toBe(true);

        const componentSource = readFileSync(componentPath, "utf8");

        expect(componentSource).toContain('type="range"');
        expect(componentSource).toContain('aria-label="调整明暗模式截图分界线"');
        expect(componentSource).toContain("setPointerCapture");
    });
});
