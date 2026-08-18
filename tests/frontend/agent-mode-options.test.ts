import { describe, expect, test } from "bun:test";

import {
    BUILT_IN_AGENT_MODE_FALLBACK_OPTIONS,
    resolveAgentModeOptions,
    resolveSelectedAgentModeOption,
} from "../../src/features/workbench/agent/mode/agent-mode-options";
import type { AvailableAgentMode } from "../../src/lib/ai-runtime/agent-modes";

describe("agent mode options", () => {
    test("falls back to built-in Ask, Query, and Agent options when Runtime catalog is unavailable", () => {
        expect(resolveAgentModeOptions(undefined)).toEqual(
            BUILT_IN_AGENT_MODE_FALLBACK_OPTIONS,
        );
        expect(resolveAgentModeOptions([])).toEqual(
            BUILT_IN_AGENT_MODE_FALLBACK_OPTIONS,
        );
        expect(
            BUILT_IN_AGENT_MODE_FALLBACK_OPTIONS.map((option) => option.agentMode),
        ).toEqual(["ask", "query", "agent"]);
    });

    test("uses Runtime catalog when it contains agent modes", () => {
        const runtimeCatalog: AvailableAgentMode[] = [
            {
                agentMode: "ask",
                title: "Ask",
                description: "Runtime Ask",
                builtIn: true,
                capabilities: ["question-answering"],
            },
        ];

        expect(resolveAgentModeOptions(runtimeCatalog)).toBe(runtimeCatalog);
    });

    test("resolves all built-in modes and falls back to Ask", () => {
        const options = resolveAgentModeOptions(undefined);

        expect(resolveSelectedAgentModeOption(options, "ask")?.agentMode).toBe("ask");
        expect(resolveSelectedAgentModeOption(options, "query")?.agentMode).toBe(
            "query",
        );
        expect(resolveSelectedAgentModeOption(options, "agent")?.agentMode).toBe(
            "agent",
        );
        expect(resolveSelectedAgentModeOption([], "ask")?.agentMode).toBe("ask");
    });
});
