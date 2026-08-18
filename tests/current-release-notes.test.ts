import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("current release notes frontend boundary", () => {
    test("uses Rust IPC instead of browser fetch for current release notes", () => {
        const source = readFileSync(
            "src/features/release-notes/current-release-notes.ts",
            "utf8",
        );

        expect(source).toContain(
            'invoke<CurrentReleaseNotes>("get_current_release_notes")',
        );
        expect(source).not.toContain("fetch(");
        expect(source).not.toContain("get_release_public_base_url");
        expect(source).not.toContain("https://dl.nexuspilot.dev/releases");
    });
});
