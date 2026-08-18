import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("website hero", () => {
    test("renders a remote release version badge instead of static config version", () => {
        const heroSource = readFileSync(
            "website/src/main-site/components/Hero.astro",
            "utf8",
        );

        expect(heroSource).toContain(
            'import { HeroReleaseBadge } from "./HeroReleaseBadge";',
        );
        expect(heroSource).toContain("<HeroReleaseBadge client:load />");
        expect(heroSource).not.toContain("currentRelease");
        expect(heroSource).not.toContain("currentRelease.version");
        expect(heroSource).not.toContain("v{currentRelease.version}");
    });

    test("hero release badge reads the public release index", () => {
        const badgePath = "website/src/main-site/components/HeroReleaseBadge.tsx";

        expect(existsSync(badgePath)).toBe(true);

        const badgeSource = readFileSync(badgePath, "utf8");

        expect(badgeSource).toContain("loadPublicReleaseIndex");
        expect(badgeSource).toContain("formatVersion");
        expect(badgeSource).not.toContain("currentRelease");
    });
});
