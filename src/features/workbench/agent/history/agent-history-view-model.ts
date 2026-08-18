import { isRuntimeConversationId } from "@/lib/ai-runtime/runtime-ids";

export interface AgentHistoryThreadItemLike {
    id: string;
    remoteId?: string | null;
    title?: string | null;
    status?: string;
    custom?: Record<string, unknown> | null;
}

export interface CreateAgentHistoryItemsInput {
    threadItems: readonly AgentHistoryThreadItemLike[];
    mainThreadId?: string | null;
    currentThreadIsRunning: boolean;
}

export interface AgentHistoryItemViewModel {
    id: string;
    remoteId?: string;
    title: string;
    statusLabel: string;
    updatedAtLabel: string;
    active: boolean;
    disabled: boolean;
    archived: boolean;
    pinned: boolean;
    pinnedAt: number | null;
    runtimeStatusType: string;
    activeRunId: string | null;
    canInterrupt: boolean;
}

export interface AgentHistoryGroupsViewModel {
    regular: AgentHistoryItemViewModel[];
    archived: AgentHistoryItemViewModel[];
}

export interface AgentHistoryRuntimeStatusViewModel {
    type: string;
    label: string;
}

type SortableAgentHistoryItemViewModel = AgentHistoryItemViewModel & {
    sortIndex: number;
    sortUpdatedAt: number;
};

interface AgentChatMessageLike {
    role?: string;
    content?: readonly unknown[];
    parts?: readonly unknown[];
}

const NEW_CONVERSATION_TITLE = "新对话";
const UNKNOWN_TIME = "未知时间";
const CHAT_TITLE_MAX_LENGTH = 34;

export function createAgentHistoryItems(
    input: CreateAgentHistoryItemsInput,
): AgentHistoryItemViewModel[] {
    return createAgentHistoryGroups(input).regular;
}

export function createAgentHistoryGroups(
    input: CreateAgentHistoryItemsInput,
): AgentHistoryGroupsViewModel {
    const rows = createSortableAgentHistoryRows(input);
    const regular = rows
        .filter((item) => !item.archived)
        .sort(compareRegularHistoryItems)
        .map(toAgentHistoryItem);
    const archived = rows
        .filter((item) => item.archived)
        .sort(compareUpdatedHistoryItems)
        .map(toAgentHistoryItem);

    return { regular, archived };
}

function createSortableAgentHistoryRows(
    input: CreateAgentHistoryItemsInput,
): SortableAgentHistoryItemViewModel[] {
    return input.threadItems.flatMap<SortableAgentHistoryItemViewModel>((threadItem, index) => {
        const runtimeThreadId = readRuntimeThreadId(threadItem);
        if (!runtimeThreadId) {
            return [];
        }

        const custom = readRecord(threadItem.custom);
        const updatedAt = readUpdatedAt(threadItem.custom);
        const runtimeStatus = readAgentHistoryRuntimeStatus(
            custom?.runtimeStatus,
        );
        const activeRunId = readActiveRunId(threadItem);
        const active =
            runtimeThreadId === input.mainThreadId ||
            threadItem.id === input.mainThreadId;
        const disabled = input.currentThreadIsRunning && !active;
        const archived = isArchivedThread(threadItem, runtimeStatus.type);
        const pinnedAt = readPinnedAt(custom);

        return [{
            id: threadItem.id,
            remoteId: runtimeThreadId,
            title: normalizeTitle(threadItem.title),
            statusLabel: runtimeStatus.label,
            updatedAtLabel: formatAgentHistoryTimestamp(updatedAt),
            active,
            disabled,
            archived,
            pinned: pinnedAt !== null,
            pinnedAt,
            runtimeStatusType: runtimeStatus.type,
            activeRunId,
            canInterrupt: runtimeStatus.type === "busy" && Boolean(activeRunId),
            sortIndex: index,
            sortUpdatedAt: normalizeSortTimestamp(updatedAt),
        }];
    });
}

function compareRegularHistoryItems(
    left: SortableAgentHistoryItemViewModel,
    right: SortableAgentHistoryItemViewModel,
): number {
    if (left.pinnedAt !== null || right.pinnedAt !== null) {
        if (left.pinnedAt === null) {
            return 1;
        }
        if (right.pinnedAt === null) {
            return -1;
        }
        return right.pinnedAt - left.pinnedAt || left.sortIndex - right.sortIndex;
    }

    return compareUpdatedHistoryItems(left, right);
}

function compareUpdatedHistoryItems(
    left: SortableAgentHistoryItemViewModel,
    right: SortableAgentHistoryItemViewModel,
): number {
    return right.sortUpdatedAt - left.sortUpdatedAt || left.sortIndex - right.sortIndex;
}

function toAgentHistoryItem({
    sortIndex: _sortIndex,
    sortUpdatedAt: _sortUpdatedAt,
    ...row
}: SortableAgentHistoryItemViewModel): AgentHistoryItemViewModel {
    return row;
}

export function canSwitchToAgentHistoryItem(
    item: AgentHistoryItemViewModel,
): boolean {
    return !item.disabled;
}

export function readAgentHistoryRuntimeStatus(
    value: unknown,
): AgentHistoryRuntimeStatusViewModel {
    const status = readRecord(value);
    const type = typeof status?.type === "string" ? status.type : "unknown";

    switch (type) {
        case "idle":
            return { type, label: "空闲" };
        case "busy":
            return { type, label: "运行中" };
        case "waiting_for_permission":
            return { type, label: "等待确认" };
        case "retry":
            return { type, label: "重试中" };
        case "error":
            return { type, label: "错误" };
        case "archived":
            return { type, label: "已归档" };
        case "interrupted":
            return { type, label: "已中断" };
        default:
            return { type: "unknown", label: "未知" };
    }
}

export function formatAgentHistoryTimestamp(value: unknown): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return UNKNOWN_TIME;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return UNKNOWN_TIME;
    }

    return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

export function getAgentChatTitle(
    currentThreadItem:
        | Pick<AgentHistoryThreadItemLike, "title">
        | null
        | undefined,
): string {
    return normalizeOptionalTitle(currentThreadItem?.title) ?? "";
}

export function getAgentChatTitleFromMessages(
    messages: readonly AgentChatMessageLike[],
): string {
    for (const message of messages) {
        if (message.role !== "user") {
            continue;
        }

        const text = readTextFromParts(message.content ?? message.parts ?? []);
        if (text) {
            return createAgentChatTitleFromText(text);
        }
    }

    return "";
}

export function createAgentChatTitleFromText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) {
        return "";
    }

    const chars = Array.from(normalized);
    if (chars.length < CHAT_TITLE_MAX_LENGTH) {
        return normalized;
    }

    return `${chars.slice(0, CHAT_TITLE_MAX_LENGTH - 3).join("")}...`;
}

function normalizeTitle(value: unknown): string {
    return normalizeOptionalTitle(value) ?? NEW_CONVERSATION_TITLE;
}

function normalizeOptionalTitle(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const title = value.trim();
    return title.length > 0 ? title : null;
}

function readRuntimeThreadId(threadItem: AgentHistoryThreadItemLike): string | null {
    if (typeof threadItem.remoteId === "string" && isRuntimeConversationId(threadItem.remoteId)) {
        return threadItem.remoteId;
    }

    return isRuntimeConversationId(threadItem.id) ? threadItem.id : null;
}

function readActiveRunId(threadItem: AgentHistoryThreadItemLike): string | null {
    const custom = readRecord(threadItem.custom);
    const activeRunId = custom?.activeRunId;
    return typeof activeRunId === "string" && activeRunId.startsWith("run_")
        ? activeRunId
        : null;
}

function readTextFromParts(parts: readonly unknown[]): string | null {
    for (const part of parts) {
        const record = readRecord(part);
        if (record?.type === "text" && typeof record.text === "string") {
            const text = record.text.trim();
            if (text) {
                return text;
            }
        }
    }

    return null;
}

function readUpdatedAt(value: unknown): unknown {
    const custom = readRecord(value);
    const time = readRecord(custom?.time);
    return time?.updated;
}

function isArchivedThread(
    threadItem: AgentHistoryThreadItemLike,
    runtimeStatusType: string,
): boolean {
    return threadItem.status === "archived" || runtimeStatusType === "archived";
}

function readPinnedAt(custom: Record<string, unknown> | null): number | null {
    const pinnedAt = custom?.pinnedAt;
    return typeof pinnedAt === "number" && Number.isFinite(pinnedAt)
        ? pinnedAt
        : null;
}

function normalizeSortTimestamp(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : Number.NEGATIVE_INFINITY;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}
