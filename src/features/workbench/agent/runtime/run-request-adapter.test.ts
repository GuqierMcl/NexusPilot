import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
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
