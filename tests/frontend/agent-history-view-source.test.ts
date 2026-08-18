import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

describe("agent history view source", () => {
    test("uses stable assistant-ui state selectors", () => {
        const source = readFileSync(
            join(
                import.meta.dir,
                "../../src/features/workbench/agent/history/AgentHistoryView.tsx",
            ),
            "utf8",
        );

        expect(source).not.toMatch(/useAuiState\s*\(\s*\([^)]*\)\s*=>\s*\(\s*\{/);
    });
});
