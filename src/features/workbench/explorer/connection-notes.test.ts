import { describe, expect, test } from "bun:test";

import {
    CONNECTION_NOTE_MAX_LENGTH,
    countConnectionNoteCharacters,
    isConnectionNoteWithinLimit,
    normalizeConnectionNote,
} from "@/features/workbench/explorer/connection-notes";

describe("connection note helpers", () => {
    test("trims outer whitespace while preserving internal line breaks", () => {
        expect(normalizeConnectionNote("  第一行\n  第二行  \n")).toBe(
            "第一行\n  第二行",
        );
        expect(normalizeConnectionNote(" \n\t ")).toBe("");
    });

    test("uses the shared explicit boundary whitespace set", () => {
        expect(normalizeConnectionNote("\uFEFF数据库备注\u0085")).toBe(
            "数据库备注",
        );
        expect(normalizeConnectionNote("数据库\u0085备注")).toBe(
            "数据库\u0085备注",
        );
    });

    test("counts Unicode code points consistently with the Rust boundary", () => {
        expect(countConnectionNoteCharacters("数据库🚀")).toBe(4);
        expect(countConnectionNoteCharacters("🚀".repeat(CONNECTION_NOTE_MAX_LENGTH))).toBe(50);
    });

    test("accepts 50 characters and rejects 51 after normalization", () => {
        expect(isConnectionNoteWithinLimit("数".repeat(50))).toBe(true);
        expect(isConnectionNoteWithinLimit(`  ${"数".repeat(50)}  `)).toBe(true);
        expect(
            isConnectionNoteWithinLimit(`\uFEFF${"数".repeat(50)}\u0085`),
        ).toBe(true);
        expect(isConnectionNoteWithinLimit("数".repeat(51))).toBe(false);
        expect(
            isConnectionNoteWithinLimit(`\uFEFF${"数".repeat(51)}\u0085`),
        ).toBe(false);
    });
});
