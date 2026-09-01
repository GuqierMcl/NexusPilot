import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
    AiRuntimeVersionMismatchAlert,
    getAiRuntimeVersionMismatch,
} from "@/features/settings/panels/ai-runtime-version-mismatch-alert";

describe("getAiRuntimeVersionMismatch", () => {
    test("returns both versions when they differ", () => {
        expect(getAiRuntimeVersionMismatch("0.10.1", "0.10.0")).toEqual({
            appVersion: "0.10.1",
            runtimeVersion: "0.10.0",
        });
    });

    test("returns null when versions match", () => {
        expect(getAiRuntimeVersionMismatch("0.10.1", "0.10.1")).toBe(null);
    });

    test("returns null until both versions are known", () => {
        expect(getAiRuntimeVersionMismatch(null, "0.10.0")).toBe(null);
        expect(getAiRuntimeVersionMismatch(undefined, "0.10.0")).toBe(null);
        expect(getAiRuntimeVersionMismatch("0.10.1", null)).toBe(null);
    });
});

describe("AiRuntimeVersionMismatchAlert", () => {
    test("shows both versions, reinstall guidance, and a download action", () => {
        const markup = renderToStaticMarkup(
            createElement(AiRuntimeVersionMismatchAlert, {
                appVersion: "0.10.1",
                runtimeVersion: "0.10.0",
                onOpenDownload: () => undefined,
            }),
        );

        expect(markup.includes("AI Runtime 版本不匹配")).toBe(true);
        expect(markup.includes("NexusPilot 版本为 0.10.1")).toBe(true);
        expect(markup.includes("AI Runtime 版本为 0.10.0")).toBe(true);
        expect(markup.includes("重新安装最新版")).toBe(true);
        expect(markup.includes("前往官网下载")).toBe(true);
    });
});
