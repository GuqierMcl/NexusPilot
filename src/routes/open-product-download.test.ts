import { describe, expect, test } from "bun:test";

import {
    PRODUCT_DOWNLOAD_URL,
    openProductDownload,
} from "@/routes/open-product-download";

describe("openProductDownload", () => {
    test("opens the fixed public download URL", async () => {
        const openedUrls: string[] = [];

        const didOpen = await openProductDownload({
            openUrl: async (url) => {
                openedUrls.push(url);
            },
            reportError: () => undefined,
        });

        expect(didOpen).toBe(true);
        expect(openedUrls).toEqual(["https://nexuspilot.dev/#download"]);
        expect(PRODUCT_DOWNLOAD_URL).toBe(
            "https://nexuspilot.dev/#download",
        );
    });

    test("reports opener failures without rejecting the click handler", async () => {
        const reportedMessages: string[] = [];

        const didOpen = await openProductDownload({
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
