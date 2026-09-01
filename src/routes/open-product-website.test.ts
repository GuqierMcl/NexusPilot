import { describe, expect, test } from "bun:test";

import {
    PRODUCT_WEBSITE_URL,
    openProductWebsite,
} from "@/routes/open-product-website";

describe("openProductWebsite", () => {
    test("opens the fixed public product website URL", async () => {
        const openedUrls: string[] = [];

        const didOpen = await openProductWebsite({
            openUrl: async (url) => {
                openedUrls.push(url);
            },
            reportError: () => undefined,
        });

        expect(didOpen).toBe(true);
        expect(openedUrls).toEqual(["https://nexuspilot.dev/"]);
        expect(PRODUCT_WEBSITE_URL).toBe("https://nexuspilot.dev/");
    });

    test("reports opener failures without rejecting the click handler", async () => {
        const reportedMessages: string[] = [];

        const didOpen = await openProductWebsite({
            openUrl: async () => {
                throw new Error("opener unavailable");
            },
            reportError: (message) => {
                reportedMessages.push(message);
            },
        });

        expect(didOpen).toBe(false);
        expect(reportedMessages).toEqual([
            "无法打开 NexusPilot 官网，请稍后重试。",
        ]);
    });
});
