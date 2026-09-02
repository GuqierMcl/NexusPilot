import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
    buildRunCreateRequestFromAiSdkMessages,
    buildRunContinueRequestFromAiSdkMessages,
    createPrepareRunSendMessagesRequest,
} from "./run-request-adapter";
import {
    clearPermissionDecision,
    registerPermissionDecision,
} from "./permission-decision-registry";

const approvalId = "approval_live_1";

describe("run continuation request adapter", () => {
    test("maps an AI SDK approval response to the canonical Runtime Permission", () => {
        registerPermissionDecision(approvalId, {
            permissionId: "perm_canonical_1",
            confirmationText: "确认执行",
        });
        const message = createApprovalMessage(approvalId);

        expect(buildRunContinueRequestFromAiSdkMessages([message])).toEqual({
            message,
            body: {
                permission_responses: [{
                    permission_id: "perm_canonical_1",
                    approved: true,
                    confirmation_text: "确认执行",
                }],
            },
        });
        clearPermissionDecision(approvalId);
    });

    test("routes approval auto-send to the same Run continue endpoint", async () => {
        registerPermissionDecision(approvalId, {
            permissionId: "perm_canonical_1",
        });
        const prepare = createPrepareRunSendMessagesRequest({
            baseUrl: "http://127.0.0.1:8787/",
            getSelectedModel: () => null,
            getActiveRunId: () => "run_active_1",
        });

        const result = await prepare({
            id: "thread_1",
            messages: [createApprovalMessage(approvalId)],
            trigger: "submit-message",
            messageId: "msg_assistant",
            api: "http://127.0.0.1:8787/v1/runs",
            body: undefined,
            credentials: undefined,
            headers: undefined,
            requestMetadata: undefined,
        });

        expect(result).toEqual({
            api: "http://127.0.0.1:8787/v1/runs/run_active_1/continue",
            body: {
                permission_responses: [{
                    permission_id: "perm_canonical_1",
                    approved: true,
                }],
            },
        });
        clearPermissionDecision(approvalId);
    });
});

describe("run attachment request adapter", () => {
    test("maps the stable Runtime scheme to attachment_id and preserves order", () => {
        expect(buildRunCreateRequestFromAiSdkMessages({
            selectedModel: { providerId: "openai", modelId: "gpt-4o" },
            messages: [{
                id: "msg_user",
                role: "user",
                parts: [
                    { type: "text", text: "  Compare  " },
                    {
                        type: "file",
                        mediaType: "image/png",
                        filename: "chart.png",
                        url: "nexuspilot-attachment:att_chart123",
                    },
                ],
            }],
        }).input.parts).toEqual([
            { type: "text", text: "Compare" },
            { type: "file", attachment_id: "att_chart123" },
        ]);
    });

    test("allows pure attachments and rejects URLs or upload ids", () => {
        const build = (url: string) => buildRunCreateRequestFromAiSdkMessages({
            selectedModel: { providerId: "openai", modelId: "gpt-4o" },
            messages: [{
                id: "msg_user",
                role: "user",
                parts: [{
                    type: "file",
                    mediaType: "application/pdf",
                    filename: "a.pdf",
                    url,
                }],
            }],
        });

        expect(build("nexuspilot-attachment:att_pdf123").input.parts).toEqual([
            { type: "file", attachment_id: "att_pdf123" },
        ]);
        for (const value of [
            "https://example.com/a.pdf",
            "nexuspilot-attachment:upl_pending",
        ]) {
            let message = "";
            try {
                build(value);
            } catch (error) {
                message = error instanceof Error ? error.message : String(error);
            }
            expect(message.includes("附件尚未完成上传")).toBe(true);
        }
    });
});

function createApprovalMessage(id: string): UIMessage {
    return {
        id: "msg_assistant",
        role: "assistant",
        parts: [{
            type: "tool-sql_execute",
            toolCallId: "call_1",
            state: "approval-responded",
            input: { sql: "DROP TABLE users" },
            approval: { id, approved: true },
        }],
    };
}
