import { describe, expect, test } from "bun:test";

import type { ToolPermissionSnapshot } from "@/lib/ai-runtime/runs";

import { canApprovePermission } from "./permission-confirmation";

const base: ToolPermissionSnapshot = {
    id: "perm_1",
    run_id: "run_1",
    message_id: "msg_1",
    tool_call_id: "tool_1",
    status: "pending",
    tool_id: "sql.execute",
    title: "执行 SQL",
    risk: {
        level: "critical",
        reversible: false,
        sideEffects: ["destructive"],
    },
    confirmation: {
        level: "strong",
        prompt: "确认在 Production MySQL 执行",
    },
    created_at: 1,
};

describe("Permission confirmation", () => {
    test("keeps strong approval locked until the prompt matches exactly", () => {
        expect(canApprovePermission(base, "")).toBe(false);
        expect(
            canApprovePermission(base, "确认在 Production MySQL 执行 "),
        ).toBe(false);
        expect(
            canApprovePermission(base, "确认在 Production MySQL 执行"),
        ).toBe(true);
    });

    test("allows a pending standard Permission without typed confirmation", () => {
        expect(
            canApprovePermission(
                {
                    ...base,
                    risk: { ...base.risk, level: "high" },
                    confirmation: { level: "standard" },
                },
                "",
            ),
        ).toBe(true);
    });
});
