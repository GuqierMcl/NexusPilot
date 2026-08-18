import type { UIMessage } from "ai";

import type { AiRuntimeEventEnvelope } from "@/lib/ai-runtime/events";

export const AGENT_REPLY_PREVIEW_MAX_LENGTH = 80;
const AGENT_NOTIFICATION_TITLE_MAX_LENGTH = 60;

export interface AgentRunNotificationPreferences {
    systemNotificationsEnabled: boolean;
    backgroundNotifications: boolean;
    showReplyPreview: boolean;
    notifyOnFailure: boolean;
}

export type AgentRunNotificationCandidate =
    | {
        kind: "completed" | "failed";
        key: string;
        runId: string;
        conversationId: string;
    }
    | {
        kind: "permission";
        key: string;
        runId: string;
        conversationId: string;
        permissionSummary: string | null;
    };

export interface AgentRunNotificationContent {
    title: string;
    body: string;
}

export function getAgentRunNotificationCandidate(
    event: AiRuntimeEventEnvelope,
): AgentRunNotificationCandidate | null {
    const properties = getEventProperties(event);
    const info = readRecord(properties?.info);

    if (event.type === "run.updated" && event.scope.kind === "run") {
        const status = typeof info?.status === "string" ? info.status : null;
        const conversationId = readConversationId(info, event);
        if (!conversationId || (status !== "completed" && status !== "failed")) {
            return null;
        }

        return {
            kind: status,
            key: `${event.scope.run_id}:${status}`,
            runId: event.scope.run_id,
            conversationId,
        };
    }

    if (
        (event.type === "permission.updated" || event.type === "permission.requested") &&
        info &&
        !info.decision
    ) {
        const runId = readRunId(info, event);
        const conversationId = readConversationId(info, event);
        const permissionId = typeof info?.id === "string" ? info.id : null;
        if (!runId || !conversationId || !permissionId) {
            return null;
        }

        return {
            kind: "permission",
            key: `${runId}:permission:${permissionId}`,
            runId,
            conversationId,
            permissionSummary: readPermissionSummary(info),
        };
    }

    return null;
}

export function createAgentRunNotificationContent(input: {
    candidate: AgentRunNotificationCandidate;
    conversationTitle: string | null | undefined;
    messages: readonly UIMessage[];
    showReplyPreview: boolean;
}): AgentRunNotificationContent {
    const conversationTitle = truncateText(
        normalizeText(input.conversationTitle) || "智能体",
        AGENT_NOTIFICATION_TITLE_MAX_LENGTH,
    );

    switch (input.candidate.kind) {
        case "completed": {
            const preview = input.showReplyPreview
                ? getAssistantReplyPreview(input.messages, input.candidate.runId)
                : null;
            return {
                title: conversationTitle,
                body: preview ?? "智能体已完成回复",
            };
        }
        case "failed":
            return {
                title: conversationTitle,
                body: "智能体执行失败",
            };
        case "permission":
            return {
                title: "需要你的审核",
                body: input.candidate.permissionSummary
                    ? `${conversationTitle}：${input.candidate.permissionSummary}`
                    : `${conversationTitle} 正在等待你的审核。`,
            };
    }
}

export function getAssistantReplyPreview(
    messages: readonly UIMessage[],
    runId: string,
): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.role !== "assistant" || getMessageRunId(message) !== runId) {
            continue;
        }

        const text = getTextParts(message);
        if (text) {
            return truncateText(text, AGENT_REPLY_PREVIEW_MAX_LENGTH);
        }
    }

    return null;
}

function getEventProperties(
    event: AiRuntimeEventEnvelope,
): Record<string, unknown> | null {
    return readRecord(readRecord(event.payload.event)?.properties);
}

function readRunId(
    info: Record<string, unknown> | null,
    event: AiRuntimeEventEnvelope,
): string | null {
    if (event.scope.kind === "run") {
        return event.scope.run_id;
    }

    return typeof info?.runId === "string" ? info.runId : null;
}

function readConversationId(
    info: Record<string, unknown> | null,
    event: AiRuntimeEventEnvelope,
): string | null {
    if (typeof info?.conversationId === "string") {
        return info.conversationId;
    }

    return event.scope.kind === "run" ? event.scope.conversation_id ?? null : null;
}

function readPermissionSummary(info: Record<string, unknown>): string | null {
    const metadata = readRecord(info.metadata);
    const inputSummary = normalizeText(metadata?.inputSummary);
    return inputSummary || normalizeText(info.title) || null;
}

function getMessageRunId(message: UIMessage): string | null {
    const metadata = readRecord(message.metadata);
    const nexus =
        readRecord(metadata?.nexus) ??
        readRecord(readRecord(metadata?.custom)?.nexus);
    return typeof nexus?.runId === "string" ? nexus.runId : null;
}

function getTextParts(message: UIMessage): string | null {
    const texts: string[] = [];

    for (const part of message.parts) {
        if (part.type === "text") {
            const text = normalizeText(part.text);
            if (text) {
                texts.push(text);
            }
        }
    }

    return texts.length > 0 ? texts.join(" ") : null;
}

function truncateText(value: string, maxLength: number): string {
    const chars = Array.from(value);
    return chars.length > maxLength
        ? `${chars.slice(0, maxLength).join("")}…`
        : value;
}

function normalizeText(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const withoutLinks = value
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[`*_>#]/g, " ");
    const normalized = withoutLinks.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}
