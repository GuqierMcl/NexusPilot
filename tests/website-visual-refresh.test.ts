import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readWebsiteFile = (path: string) => readFileSync(path, "utf8");

describe("website visual refresh", () => {
    test("places the theme comparison inside a product stage instead of bare page chrome", () => {
        const componentSource = readWebsiteFile(
            "website/src/main-site/components/ThemeComparisonSlider.tsx",
        );

        expect(componentSource).toContain("theme-comparison-stage");
        expect(componentSource).toContain("theme-comparison-frame");
        expect(componentSource).toContain("theme-comparison-handle");
    });

    test("uses shared section band styles across the homepage", () => {
        const featuresSource = readWebsiteFile(
            "website/src/main-site/components/Features.astro",
        );
        const databaseSource = readWebsiteFile(
            "website/src/main-site/components/DatabaseMatrix.astro",
        );
        const downloadSource = readWebsiteFile(
            "website/src/main-site/components/Download.astro",
        );
        const stylesSource = readWebsiteFile(
            "website/src/main-site/styles/global.css",
        );

        expect(featuresSource).toContain("section-band section-band-features");
        expect(databaseSource).toContain("section-band section-band-databases");
        expect(downloadSource).toContain("section-band section-band-download");
        expect(stylesSource).toContain(".section-band");
        expect(stylesSource).toContain(".feature-item");
        expect(stylesSource).toContain(".database-pill");
    });

    test("removes the old discrete orb decoration from the homepage hero", () => {
        const heroSource = readWebsiteFile(
            "website/src/main-site/components/Hero.astro",
        );

        expect(heroSource).toContain("hero-shell");
        expect(heroSource).not.toContain("Gradient orbs");
        expect(heroSource).not.toContain("rounded-full bg-indigo");
        expect(heroSource).not.toContain("rounded-full bg-violet");
        expect(heroSource).not.toContain("rounded-full bg-blue");
    });
});
