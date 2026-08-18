import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "..", "src");
const FORBIDDEN_STAGE_TERM = /\b(?:Phase|phase)\s*\d+[A-Za-z]*\b/;

function productionFrontendFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            return productionFrontendFiles(path);
        }
        if (!/\.(?:ts|tsx)$/.test(entry.name)) {
            return [];
        }
        if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) {
            return [];
        }
        return [path];
    });
}

describe("user-facing copy", () => {
    test("does not expose internal phase identifiers in production frontend source", () => {
        const violations = productionFrontendFiles(SOURCE_ROOT).flatMap(
            (path) => {
                const lines = readFileSync(path, "utf8").split(/\r?\n/);
                return lines.flatMap((line, index) =>
                    FORBIDDEN_STAGE_TERM.test(line)
                        ? [`${relative(SOURCE_ROOT, path)}:${index + 1}`]
                        : [],
                );
            },
        );

        expect(violations).toEqual([]);
    });
});
