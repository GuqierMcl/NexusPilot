import { describe, expect, test } from "bun:test";

import {
    CONNECTION_TAG_LABEL_MAX_LENGTH,
    DEFAULT_CONNECTION_TAG_COLOR,
    getConnectionTagColor,
    getConnectionTagRenderModel,
    normalizeConnectionTagInput,
} from "@/features/workbench/explorer/connection-tags";

describe("connection tag helpers", () => {
    test("normalizes empty tags to no rendered tag", () => {
        const normalized = normalizeConnectionTagInput({
            tagLabel: "   ",
            tagColor: null,
        });

        expect(normalized).toEqual({ tagLabel: "", tagColor: null });
        expect(getConnectionTagRenderModel(normalized)).toEqual({ kind: "none" });
    });

    test("keeps color-only tags as marker render model", () => {
        const normalized = normalizeConnectionTagInput({
            tagLabel: "",
            tagColor: "emerald",
        });

        expect(normalized).toEqual({ tagLabel: "", tagColor: "emerald" });
        expect(getConnectionTagRenderModel(normalized)).toEqual({
            kind: "marker",
            color: getConnectionTagColor("emerald"),
        });
    });

    test("uses default color when label is present without color", () => {
        const normalized = normalizeConnectionTagInput({
            tagLabel: "  Prod  ",
            tagColor: null,
        });

        expect(normalized).toEqual({
            tagLabel: "Prod",
            tagColor: DEFAULT_CONNECTION_TAG_COLOR,
        });
    });

    test("limits label to fixed visible character count", () => {
        const normalized = normalizeConnectionTagInput({
            tagLabel: "一二三四五六七八九",
            tagColor: "sky",
        });

        expect(CONNECTION_TAG_LABEL_MAX_LENGTH).toBe(8);
        expect(normalized.tagLabel).toBe("一二三四五六七八");
    });

    test("ignores unknown color keys", () => {
        const normalized = normalizeConnectionTagInput({
            tagLabel: "",
            tagColor: "#ff0000",
        });

        expect(normalized).toEqual({ tagLabel: "", tagColor: null });
    });
});
