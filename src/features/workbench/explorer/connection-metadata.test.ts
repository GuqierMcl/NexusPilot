import { describe, expect, test } from "bun:test";

import {
    buildConnectionMetadataSummary,
    createConnectionMetadataDisclosureState,
    reduceConnectionMetadataDisclosure,
} from "@/features/workbench/explorer/connection-metadata";

describe("connection metadata summary", () => {
    test("describes an empty optional metadata section", () => {
        expect(buildConnectionMetadataSummary({
            tagLabel: "",
            tagColor: null,
            note: "",
        })).toEqual({
            text: "未设置",
            tagColor: null,
        });
    });

    test("describes color-only and label metadata", () => {
        expect(buildConnectionMetadataSummary({
            tagLabel: "",
            tagColor: "emerald",
            note: "",
        })).toEqual({
            text: "已设置颜色",
            tagColor: "emerald",
        });

        expect(buildConnectionMetadataSummary({
            tagLabel: "  生产  ",
            tagColor: null,
            note: "",
        })).toEqual({
            text: "生产",
            tagColor: "sky",
        });
    });

    test("shows note text directly and flattens line breaks in the compact summary", () => {
        expect(buildConnectionMetadataSummary({
            tagLabel: "",
            tagColor: null,
            note: "  仅内网\n使用  ",
        })).toEqual({
            text: "仅内网 使用",
            tagColor: null,
        });

        expect(buildConnectionMetadataSummary({
            tagLabel: "生产",
            tagColor: "violet",
            note: "不要执行写操作",
        })).toEqual({
            text: "生产 · 不要执行写操作",
            tagColor: "violet",
        });
    });
});

describe("connection metadata disclosure state", () => {
    test("starts collapsed and resets to collapsed whenever a dialog opens", () => {
        const initial = createConnectionMetadataDisclosureState();

        expect(initial).toEqual({
            open: false,
            focusNote: false,
        });

        const opened = reduceConnectionMetadataDisclosure(initial, {
            type: "set-open",
            open: true,
        });
        expect(opened.open).toBe(true);
        expect(reduceConnectionMetadataDisclosure(opened, {
            type: "reset",
        })).toEqual({
            open: false,
            focusNote: false,
        });
    });

    test("reveals the section and requests note focus after invalid submission", () => {
        const revealed = reduceConnectionMetadataDisclosure(
            createConnectionMetadataDisclosureState(),
            { type: "reveal-invalid-note" },
        );

        expect(revealed).toEqual({
            open: true,
            focusNote: true,
        });
        expect(reduceConnectionMetadataDisclosure(revealed, {
            type: "note-focused",
        })).toEqual({
            open: true,
            focusNote: false,
        });
    });
});
