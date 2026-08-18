import {
    isToolUIPart,
    type PrepareSendMessagesRequest,
    type UIMessage,
} from "ai";

import type {
    RunAgentMode,
    RunCreateRequest,
    RunCreateRequestMetadata,
    RunCreateTextInputPart,
    RunContinueRequest,
    RunModelSelection,
} from "@/lib/ai-runtime/runs";
import { buildRunContinuePath } from "@/lib/ai-runtime/runs";

import { readPermissionDecision } from "./permission-decision-registry";

export type RunRequestAdapterErrorCode =
    | "missing_model"
    | "missing_user_message"
    | "empty_user_input"
    | "unsupported_input_part"
    | "unsupported_trigger"
    | "missing_run"
    | "missing_permission_mapping";

export class RunRequestAdapterError extends Error {
    readonly code: RunRequestAdapterErrorCode;
    readonly partType?: string;

    constructor(
        code: RunRequestAdapterErrorCode,
        message: string,
        options: { partType?: string } = {},
    ) {
        super(message);
        this.name = "RunRequestAdapterError";
        this.code = code;
        this.partType = options.partType;
    }
}

export interface BuildRunCreateRequestInput {
    messages: UIMessage[];
    selectedModel: RunModelSelection | null;
    selectedAgentMode?: RunAgentMode;
    conversationId?: string | null;
    replaceFromMessageId?: string | null;
    trigger?: "submit-message" | "regenerate-message";
    messageId?: string;
    clientThreadId?: string;
}

export interface ResolveRunConversationIdContext {
    clientThreadId?: string;
}

export interface CreatePrepareRunSendMessagesRequestOptions {
    baseUrl: string;
    getSelectedModel: () => RunModelSelection | null;
    getSelectedAgentMode?: () => RunAgentMode;
    getConversationId?: (
        context: ResolveRunConversationIdContext,
    ) => string | null | undefined;
    consumeReplacementMessageId?: () => string | null | undefined;
    getActiveRunId?: (context: ResolveRunConversationIdContext) => string | null;
}

export function buildRunCreateRequestFromAiSdkMessages(
    input: BuildRunCreateRequestInput,
): RunCreateRequest {
    const selectedModel = normalizeSelectedModel(input.selectedModel);
    if (!selectedModel) {
        throw new RunRequestAdapterError(
            "missing_model",
            "发送前必须先选择一个可用模型。",
        );
    }

    if (input.trigger === "regenerate-message") {
        throw new RunRequestAdapterError(
            "unsupported_trigger",
            "当前阶段暂不支持重新生成消息。",
        );
    }

    const userMessage = findLastUserMessage(input.messages);
    if (!userMessage) {
        throw new RunRequestAdapterError(
            "missing_user_message",
            "没有可发送的用户消息。",
        );
    }

    const parts = extractTextInputParts(userMessage);
    const metadata = buildMetadata({
        clientThreadId: input.clientThreadId,
        clientUserMessageId: userMessage.id,
        trigger: input.trigger,
        messageId: input.messageId,
    });
    const conversationId = normalizeOptionalString(input.conversationId);
    const replaceFromMessageId = normalizeOptionalString(
        input.replaceFromMessageId,
    );

    return {
        response_mode: "stream",
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(replaceFromMessageId
            ? { replace_from_message_id: replaceFromMessageId }
            : {}),
        model: {
            provider_id: selectedModel.providerId,
            model_id: selectedModel.modelId,
        },
        agent_mode: input.selectedAgentMode ?? ("ask" satisfies RunAgentMode),
        input: { parts },
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
}

export function createPrepareRunSendMessagesRequest(
    options: CreatePrepareRunSendMessagesRequestOptions,
): PrepareSendMessagesRequest<UIMessage> {
    return async (request) => {
        const continuation = buildRunContinueRequestFromAiSdkMessages(
            request.messages,
        );
        if (continuation) {
            const runId =
                readRunIdFromMessage(continuation.message) ??
                options.getActiveRunId?.({ clientThreadId: request.id }) ??
                null;
            if (!runId) {
                throw new RunRequestAdapterError(
                    "missing_run",
                    "无法确定等待审批的 Runtime Run。",
                );
            }
            return {
                api: `${options.baseUrl.replace(/\/+$/, "")}${buildRunContinuePath(runId)}`,
                body: continuation.body,
            };
        }

        return {
            body: buildRunCreateRequestFromAiSdkMessages({
            messages: request.messages,
            selectedModel: options.getSelectedModel(),
            selectedAgentMode: options.getSelectedAgentMode?.(),
            conversationId: options.getConversationId?.({
                clientThreadId: request.id,
            }),
            replaceFromMessageId:
                request.trigger === "submit-message"
                    ? (options.consumeReplacementMessageId?.() ?? null)
                    : null,
            trigger: request.trigger,
            messageId: request.messageId,
            clientThreadId: request.id,
            }),
        };
    };
}

export function buildRunContinueRequestFromAiSdkMessages(
    messages: UIMessage[],
): { message: UIMessage; body: RunContinueRequest } | null {
    const message = messages.at(-1);
    if (!message || message.role !== "assistant") {
        return null;
    }

    const lastStepStartIndex = message.parts.reduce(
        (lastIndex, part, index) =>
            part.type === "step-start" ? index : lastIndex,
        -1,
    );
    const responded = message.parts
        .slice(lastStepStartIndex + 1)
        .filter(isToolUIPart)
        .filter((part) => part.state === "approval-responded");
    if (responded.length === 0) {
        return null;
    }

    const permissionResponses = responded.map((part) => {
        const registered = readPermissionDecision(part.approval.id);
        const permissionId = registered?.permissionId ??
            (part.approval.id.startsWith("perm_")
                ? part.approval.id
                : null);
        if (!permissionId) {
            throw new RunRequestAdapterError(
                "missing_permission_mapping",
                "实时审批尚未解析为 Runtime Permission。",
            );
        }
        return {
            permission_id: permissionId,
            approved: part.approval.approved,
            ...(registered?.confirmationText !== undefined
                ? { confirmation_text: registered.confirmationText }
                : {}),
            ...(part.approval.reason
                ? { reason: part.approval.reason }
                : {}),
        };
    });

    return {
        message,
        body: { permission_responses: permissionResponses },
    };
}

export function formatRunRequestAdapterError(error: unknown): string | null {
    if (!(error instanceof RunRequestAdapterError)) {
        return null;
    }

    switch (error.code) {
        case "unsupported_trigger":
            return "该操作即将支持";
        case "unsupported_input_part":
            return "当前版本暂不支持此输入类型";
        case "missing_model":
            return "请选择模型";
        case "missing_user_message":
            return "没有可发送的用户消息";
        case "missing_run":
            return "无法恢复等待审批的运行";
        case "missing_permission_mapping":
            return "审批信息仍在同步，请稍后重试";
        case "empty_user_input":
            return null;
    }
}

function readRunIdFromMessage(message: UIMessage): string | null {
    if (!isRecord(message.metadata)) {
        return null;
    }
    const nexus = isRecord(message.metadata.nexus)
        ? message.metadata.nexus
        : isRecord(message.metadata.custom) &&
              isRecord(message.metadata.custom.nexus)
          ? message.metadata.custom.nexus
          : null;
    return nexus ? normalizeOptionalString(nexus.runId as string | undefined) : null;
}

function findLastUserMessage(messages: UIMessage[]): UIMessage | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "user") {
            return message;
        }
    }

    return null;
}

function extractTextInputParts(message: UIMessage): RunCreateTextInputPart[] {
    const result: RunCreateTextInputPart[] = [];

    for (const part of message.parts) {
        if (!isRecord(part)) {
            throw new RunRequestAdapterError(
                "unsupported_input_part",
                "当前阶段仅支持文本输入。",
                { partType: "unknown" },
            );
        }

        const partRecord: Record<string, unknown> = part;
        const partType =
            typeof partRecord.type === "string" ? partRecord.type : "unknown";
        if (partType !== "text") {
            throw new RunRequestAdapterError(
                "unsupported_input_part",
                `当前阶段暂不支持 ${partType} 输入。`,
                { partType },
            );
        }

        const partText = partRecord.text;
        const text = typeof partText === "string" ? partText.trim() : "";
        if (text.length > 0) {
            result.push({ type: "text", text });
        }
    }

    if (result.length === 0) {
        throw new RunRequestAdapterError(
            "empty_user_input",
            "用户输入不能为空。",
        );
    }

    return result;
}

function buildMetadata(input: {
    clientThreadId?: string;
    clientUserMessageId?: string;
    trigger?: "submit-message" | "regenerate-message";
    messageId?: string;
}): RunCreateRequestMetadata {
    const metadata: RunCreateRequestMetadata = {};
    const clientThreadId = normalizeOptionalString(input.clientThreadId);
    const clientUserMessageId = normalizeOptionalString(input.clientUserMessageId);
    const requestMessageId = normalizeOptionalString(input.messageId);

    if (clientThreadId) {
        metadata.client_thread_id = clientThreadId;
    }
    if (clientUserMessageId) {
        metadata.client_user_message_id = clientUserMessageId;
    }
    if (input.trigger) {
        metadata.request_trigger = input.trigger;
    }
    if (requestMessageId) {
        metadata.request_message_id = requestMessageId;
    }

    return metadata;
}

function normalizeSelectedModel(
    value: RunModelSelection | null,
): RunModelSelection | null {
    if (!value) {
        return null;
    }

    const providerId = normalizeOptionalString(value.providerId);
    const modelId = normalizeOptionalString(value.modelId);
    if (!providerId || !modelId) {
        return null;
    }

    return { providerId, modelId };
}

function normalizeOptionalString(value: string | null | undefined): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
