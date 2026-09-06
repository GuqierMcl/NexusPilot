import { describe, expect, test } from "bun:test";

import type { AiRuntimeEventEnvelope } from "@/lib/ai-runtime/events";

import {
    createEmptyPendingRuntimeHistoryScope,
    markPendingRuntimeHistoryScope,
    shouldReloadRuntimeHistory,
} from "./runtime-history-reload-policy";

function event(
    type: string,
    scope: AiRuntimeEventEnvelope["scope"],
): AiRuntimeEventEnvelope {
    return {
        id: `evt_${type}`,
        type,
        scope,
        occurred_at: 1,
        version: 1,
        payload: {},
    };
}

describe("runtime history reload policy", () => {
    test("keeps ordinary snapshots deferred while the active thread is running", () => {
        const pending = createEmptyPendingRuntimeHistoryScope();
        markPendingRuntimeHistoryScope(
            pending,
            event("message.updated", {
                kind: "run",
                conversation_id: "conv_active",
                run_id: "run_active",
            }),
        );

        expect(shouldReloadRuntimeHistory({
            conversationId: "conv_active",
            isRunning: true,
            pending,
        })).toBe(false);
        expect(shouldReloadRuntimeHistory({
            conversationId: "conv_active",
            isRunning: false,
            pending,
        })).toBe(true);
    });

    test("allows durable compaction lifecycle snapshots during a running thread", () => {
        const pending = createEmptyPendingRuntimeHistoryScope();
        markPendingRuntimeHistoryScope(
            pending,
            event("context.compaction.updated", {
                kind: "run",
                conversation_id: "conv_active",
                run_id: "run_active",
            }),
        );

        expect(pending.runningReloadConversationIds).toEqual(
            new Set(["conv_active"]),
        );
        expect(shouldReloadRuntimeHistory({
            conversationId: "conv_active",
            isRunning: true,
            pending,
        })).toBe(true);
        expect(shouldReloadRuntimeHistory({
            conversationId: "conv_other",
            isRunning: true,
            pending,
        })).toBe(false);
    });

    test("does not let a global ordinary event bypass the running guard", () => {
        const pending = createEmptyPendingRuntimeHistoryScope();
        markPendingRuntimeHistoryScope(
            pending,
            event("runtime.health.updated", { kind: "global" }),
        );

        expect(shouldReloadRuntimeHistory({
            conversationId: "conv_active",
            isRunning: true,
            pending,
        })).toBe(false);
    });
});
