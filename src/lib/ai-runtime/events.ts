import { appendAiRuntimeAuthorization } from "./endpoint";

export interface AiRuntimeEventScopeGlobal {
    kind: "global";
}

export interface AiRuntimeEventScopeConversation {
    kind: "conversation";
    conversation_id: string;
}

export interface AiRuntimeEventScopeRun {
    kind: "run";
    conversation_id?: string;
    run_id: string;
}

export type AiRuntimeEventScope =
    | AiRuntimeEventScopeGlobal
    | AiRuntimeEventScopeConversation
    | AiRuntimeEventScopeRun;

export interface AiRuntimeEventEnvelope {
    id: string;
    type: string;
    scope: AiRuntimeEventScope;
    occurred_at: number;
    version: 1;
    payload: Record<string, unknown>;
}

export type AiRuntimeEventSubscriptionScope =
    | Record<string, never>
    | { conversationId: string; runId?: never }
    | { conversationId?: never; runId: string };

export interface SubscribeAiRuntimeEventsOptions {
    baseUrl: string;
    accessToken?: string | null;
    scope?: AiRuntimeEventSubscriptionScope;
    fetch?: typeof fetch;
    reconnectDelayMs?: number;
    onEvent: (event: AiRuntimeEventEnvelope) => void;
    onError?: (error: unknown) => void;
}

interface ConsumeAiRuntimeEventStreamOptions extends SubscribeAiRuntimeEventsOptions {
    signal: AbortSignal;
}

export function buildAiRuntimeEventsUrl(
    baseUrl: string,
    scope: AiRuntimeEventSubscriptionScope = {},
): string {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    const url = new URL(`${normalizedBaseUrl}/v1/events`);

    if (scope.conversationId && scope.runId) {
        throw new Error("conversationId and runId are mutually exclusive.");
    }

    if (scope.conversationId) {
        url.searchParams.set("conversation_id", scope.conversationId);
    } else if (scope.runId) {
        url.searchParams.set("run_id", scope.runId);
    }

    return url.toString();
}

export function parseAiRuntimeEventData(
    data: string,
): AiRuntimeEventEnvelope | null {
    try {
        const parsed = JSON.parse(data) as unknown;
        return isAiRuntimeEventEnvelope(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function parseAiRuntimeSseEventBlock(
    block: string,
): AiRuntimeEventEnvelope | null {
    const dataLines: string[] = [];

    for (const rawLine of block.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (line.length === 0 || line.startsWith(":")) {
            continue;
        }

        if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
        }
    }

    if (dataLines.length === 0) {
        return null;
    }

    return parseAiRuntimeEventData(dataLines.join("\n"));
}

export function subscribeAiRuntimeEvents(
    options: SubscribeAiRuntimeEventsOptions,
): () => void {
    const controller = new AbortController();

    void consumeAiRuntimeEventStreamWithReconnect(options, controller.signal);

    return () => {
        controller.abort();
    };
}

async function consumeAiRuntimeEventStreamWithReconnect(
    options: SubscribeAiRuntimeEventsOptions,
    signal: AbortSignal,
): Promise<void> {
    const reconnectDelayMs = Math.max(options.reconnectDelayMs ?? 3_000, 250);

    while (!signal.aborted) {
        try {
            await consumeAiRuntimeEventStream({
                ...options,
                signal,
            });
        } catch (error) {
            if (signal.aborted) {
                return;
            }

            options.onError?.(error);
        }

        await sleep(reconnectDelayMs, signal);
    }
}

async function consumeAiRuntimeEventStream(
    options: ConsumeAiRuntimeEventStreamOptions,
): Promise<void> {
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await fetchImpl(buildAiRuntimeEventsUrl(options.baseUrl, options.scope), {
        headers: appendAiRuntimeAuthorization({
            Accept: "text/event-stream",
        }, options.accessToken ?? null),
        signal: options.signal,
    });

    if (!response.ok) {
        throw new Error(`AI Runtime EventBus 请求失败：HTTP ${response.status}`);
    }

    if (!response.body) {
        throw new Error("AI Runtime EventBus 响应缺少 readable stream。");
    }

    await readSseStream(response.body, options.onEvent, options.signal);
}

async function readSseStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: AiRuntimeEventEnvelope) => void,
    signal: AbortSignal,
): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            buffer = drainSseBuffer(buffer, onEvent);
        }

        buffer += decoder.decode();
        drainSseBuffer(`${buffer}\n\n`, onEvent);
    } finally {
        reader.releaseLock();
    }
}

function drainSseBuffer(
    buffer: string,
    onEvent: (event: AiRuntimeEventEnvelope) => void,
): string {
    let nextBuffer = buffer;

    while (true) {
        const separatorIndex = findSseSeparator(nextBuffer);
        if (separatorIndex < 0) {
            return nextBuffer;
        }

        const block = nextBuffer.slice(0, separatorIndex);
        nextBuffer = nextBuffer.slice(separatorIndex + readSeparatorLength(nextBuffer, separatorIndex));
        const event = parseAiRuntimeSseEventBlock(block);
        if (event) {
            onEvent(event);
        }
    }
}

function findSseSeparator(buffer: string): number {
    const lfIndex = buffer.indexOf("\n\n");
    const crlfIndex = buffer.indexOf("\r\n\r\n");

    if (lfIndex < 0) {
        return crlfIndex;
    }
    if (crlfIndex < 0) {
        return lfIndex;
    }

    return Math.min(lfIndex, crlfIndex);
}

function readSeparatorLength(buffer: string, index: number): number {
    return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}

function isAiRuntimeEventEnvelope(value: unknown): value is AiRuntimeEventEnvelope {
    if (!isRecord(value)) {
        return false;
    }

    return (
        typeof value.id === "string" &&
        typeof value.type === "string" &&
        isRecord(value.scope) &&
        typeof value.occurred_at === "number" &&
        value.version === 1 &&
        isRecord(value.payload)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const timeout = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timeout);
                resolve();
            },
            { once: true },
        );
    });
}
