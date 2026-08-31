import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const updatePromptSource = readFileSync(
    "src/features/update/UpdatePrompt.tsx",
    "utf8",
);
const mainLayoutSource = readFileSync("src/routes/main-layout.tsx", "utf8");
const aboutPanelSource = readFileSync(
    "src/features/settings/panels/AboutPanel.tsx",
    "utf8",
);

describe("update prompt integration", () => {
    test("uses the expandable icon presentation in both title bar slots", () => {
        expect(
            mainLayoutSource.match(/<UpdatePrompt appearance="icon" \/>/g)?.length,
        ).toBe(2);
        expect(mainLayoutSource.includes("UpdatePromptBadge")).toBe(false);
    });

    test("keeps the badge presentation in the about panel", () => {
        expect(
            aboutPanelSource.includes('<UpdatePrompt appearance="badge" />'),
        ).toBe(true);
    });

    test("preserves title bar interaction and reduced-motion behavior", () => {
        expect(updatePromptSource.includes('data-no-drag="true"')).toBe(true);
        expect(updatePromptSource.includes('tooltipSide="bottom"')).toBe(true);
        expect(
            updatePromptSource.includes("group-hover/update-prompt:max-w-16"),
        ).toBe(true);
        expect(
            updatePromptSource.includes(
                "group-focus-visible/update-prompt:max-w-16",
            ),
        ).toBe(true);
        expect(updatePromptSource.includes("motion-reduce:transition-none")).toBe(
            true,
        );
        expect(updatePromptSource.includes("setUpdateDialogOpen(true)")).toBe(true);
    });
});
