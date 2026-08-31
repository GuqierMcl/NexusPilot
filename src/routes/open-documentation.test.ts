import { describe, expect, test } from "bun:test";

import {
    DOCUMENTATION_URL,
    openDocumentation,
} from "@/routes/open-documentation";

describe("openDocumentation", () => {
    test("opens the fixed public documentation URL", async () => {
        const openedUrls: string[] = [];

        const didOpen = await openDocumentation({
            openUrl: async (url) => {
                openedUrls.push(url);
            },
            reportError: () => undefined,
        });

        expect(didOpen).toBe(true);
        expect(openedUrls).toEqual(["https://docs.nexuspilot.dev"]);
        expect(DOCUMENTATION_URL).toBe("https://docs.nexuspilot.dev");
    });

    test("reports opener failures without rejecting the click handler", async () => {
        const reportedMessages: string[] = [];

        const didOpen = await openDocumentation({
            openUrl: async () => {
                throw new Error("opener unavailable");
            },
            reportError: (message) => {
                reportedMessages.push(message);
            },
        });

        expect(didOpen).toBe(false);
        expect(reportedMessages).toEqual(["无法打开在线文档，请稍后重试。"]);
    });
});
