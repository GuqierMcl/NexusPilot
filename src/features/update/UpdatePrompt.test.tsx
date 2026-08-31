import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UpdatePromptContent } from "@/features/update/UpdatePrompt";
import type { AvailableUpdateInfo } from "@/store/slices/update-slice";

const availableUpdateInfo: AvailableUpdateInfo = {
    currentVersion: "0.1.0",
    version: "0.2.0",
    rawJson: {},
};

function render(appearance: "badge" | "icon"): string {
    return renderToStaticMarkup(
        createElement(UpdatePromptContent, {
            appearance,
            availableUpdateInfo,
            onOpen: () => undefined,
        }),
    );
}

describe("UpdatePromptContent", () => {
    test("renders a compact expandable icon prompt for the title bar", () => {
        const markup = render("icon");

        expect(markup.includes('data-slot="update-prompt-icon"')).toBe(true);
        expect(markup.includes('data-no-drag="true"')).toBe(true);
        expect(markup.includes("新版本")).toBe(true);
        expect(markup.includes("发现新版本 0.2.0")).toBe(true);
        expect(markup.includes("group-hover/update-prompt:max-w-16")).toBe(true);
        expect(markup.includes("group-focus-visible/update-prompt:max-w-16")).toBe(true);
        expect(markup.includes("motion-reduce:transition-none")).toBe(true);
        expect(markup.includes("有新版本")).toBe(false);
    });

    test("keeps the text badge presentation for the about panel", () => {
        const markup = render("badge");

        expect(markup.includes("有新版本")).toBe(true);
        expect(markup.includes('data-slot="update-prompt-icon"')).toBe(false);
        expect(markup.includes("发现新版本 0.2.0")).toBe(true);
    });
});
