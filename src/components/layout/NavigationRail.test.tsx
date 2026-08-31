import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";

import {
    createBottomRailActions,
    NavigationRail,
} from "@/components/layout/NavigationRail";

describe("NavigationRail", () => {
    test("renders Documentation above Settings as separate utility actions", () => {
        const markup = renderToStaticMarkup(createElement(NavigationRail));
        const documentationIndex = markup.indexOf("文档");
        const settingsIndex = markup.indexOf("设置");

        expect(documentationIndex >= 0).toBe(true);
        expect(settingsIndex > documentationIndex).toBe(true);
        expect(markup.includes('aria-label="文档"')).toBe(true);
        expect(markup.includes('aria-label="设置"')).toBe(true);
    });

    test("keeps Documentation and Settings callbacks independent", () => {
        const calls: string[] = [];
        const actions = createBottomRailActions({
            onDocumentationClick: () => calls.push("documentation"),
            onSettingsClick: () => calls.push("settings"),
        });

        actions[0]?.onClick?.(undefined as never);
        expect(calls.join(",")).toBe("documentation");

        actions[1]?.onClick?.(undefined as never);
        expect(calls.join(",")).toBe("documentation,settings");
    });
});
