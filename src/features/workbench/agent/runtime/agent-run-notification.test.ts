import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import type { AiRuntimeEventEnvelope } from "@/lib/ai-runtime/events";

import {
    AGENT_REPLY_PREVIEW_MAX_LENGTH,
    createAgentRunNotificationContent,
    getAgentRunNotificationCandidate,
    getAssistantReplyPreview,
} from "./agent-run-notification";

describe("agent run notification", () => {
    test("uses the completed run's assistant text as a plain-text preview", () => {
        const messages = [
            {
                id: "msg_other",
                role: "assistant",
                parts: [{ type: "text", text: "不应显示" }],
                metadata: { nexus: { runId: "run_other" } },
            },
            {
                id: "msg_current",
                role: "assistant",
                parts: [{ type: "text", text: "## **已完成** [查看结果](https://example.com)" }],
                metadata: { nexus: { runId: "run_current" } },
            },
        ] as UIMessage[];

        expect(getAssistantReplyPreview(messages, "run_current")).toBe(
            "已完成 查看结果",
        );
    });

    test("truncates long reply previews by visible character count", () => {
        const message = {
            id: "msg_current",
            role: "assistant",
            parts: [{ type: "text", text: "一".repeat(AGENT_REPLY_PREVIEW_MAX_LENGTH + 1) }],
            metadata: { nexus: { runId: "run_current" } },
        } as UIMessage;

        expect(getAssistantReplyPreview([message], "run_current")).toBe(
            `${"一".repeat(AGENT_REPLY_PREVIEW_MAX_LENGTH)}…`,
        );
    });

    test("creates a completion notification with the conversation title only", () => {
        const candidate = getAgentRunNotificationCandidate(createRunEvent("completed"));
        if (!candidate || candidate.kind !== "completed") {
            throw new Error("expected a completed run notification candidate");
        }

        expect(
            createAgentRunNotificationContent({
                candidate,
                conversationTitle: "分析订单异常",
                messages: [
                    {
                        id: "msg_current",
                        role: "assistant",
                        parts: [{ type: "text", text: "已经定位到异常订单。" }],
                        metadata: { nexus: { runId: "run_current" } },
                    } as UIMessage,
                ],
                showReplyPreview: true,
            }),
        ).toEqual({
            title: "分析订单异常",
            body: "已经定位到异常订单。",
        });
    });

    test("recognizes a pending permission event for future review notifications", () => {
        const event: AiRuntimeEventEnvelope = {
            id: "evt_permission",
            type: "permission.updated",
            scope: {
                kind: "run",
                conversation_id: "conv_current",
                run_id: "run_current",
            },
            occurred_at: 1,
            version: 1,
            payload: {
                event: {
                    properties: {
                        info: {
                            id: "perm_current",
                            conversationId: "conv_current",
                            runId: "run_current",
                            title: "执行连接操作",
                            metadata: { inputSummary: "将连接到生产数据库" },
                        },
                    },
                },
            },
        };

        expect(getAgentRunNotificationCandidate(event)).toEqual({
            kind: "permission",
            key: "run_current:permission:perm_current",
            runId: "run_current",
            conversationId: "conv_current",
            permissionSummary: "将连接到生产数据库",
        });
    });
});

function createRunEvent(status: "completed" | "failed"): AiRuntimeEventEnvelope {
    return {
        id: `evt_${status}`,
        type: "run.updated",
        scope: {
            kind: "run",
            conversation_id: "conv_current",
            run_id: "run_current",
        },
        occurred_at: 1,
        version: 1,
        payload: {
            event: {
                properties: {
                    info: {
                        status,
                        conversationId: "conv_current",
                    },
                },
            },
        },
    };
}
