"use client";

import {
    AssistantRuntimeProvider,
    RuntimeAdapterProvider,
    useAui,
    useAuiState,
    useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import {
    AssistantChatTransport,
    useChatRuntime,
} from "@assistant-ui/react-ai-sdk";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MutableRefObject,
    type ReactNode,
} from "react";
import { toast } from "@/components/ui/toast";

import { useSelectedAiRuntimeAgentMode } from "@/features/workbench/agent/mode";
import { useSelectedAiRuntimeModel } from "@/features/workbench/agent/model";
import { useAgentStatusSnapshotStore } from "@/features/workbench/agent/state";
import {
    subscribeAiRuntimeEvents,
    type AiRuntimeEventEnvelope,
} from "@/lib/ai-runtime/events";
import { isRuntimeConversationId } from "@/lib/ai-runtime/runtime-ids";
import type { RunModelSelection } from "@/lib/ai-runtime/runs";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";
import { useSettingsStore } from "@/store/slices/settings-slice";

import { createAiRuntimeHistoryAdapter } from "./ai-runtime-history-adapter";
import {
    createAiRuntimeThreadListAdapter,
    reloadRuntimeThreadHistorySnapshot,
} from "./ai-runtime-thread-list-adapter";
import {
    createAgentRuntimeTransportOptions,
    shouldDisableAgentRuntimeSend,
} from "./create-agent-chat-transport";
import { AgentActiveRunState } from "./active-run-state";
import { AgentStatusSnapshotReporter } from "./AgentStatusSnapshotReporter";
import {
    getAgentRunNotificationCandidate,
    type AgentRunNotificationPreferences,
} from "./agent-run-notification";
import { dispatchAgentRunNotification } from "./agent-run-notification-dispatcher";
import { AgentRuntimeInterruptProvider } from "./run-interrupt-context";
import {
    AgentMessageEditProvider,
    type AgentMessageEditController,
} from "./agent-message-edit-context";
import { AgentToolPermissionProvider } from "./tool-permission-context";
import { RuntimeAttachmentAdapter } from "./runtime-attachment-adapter";

interface AgentAssistantRuntimeProviderProps {
    children: ReactNode;
}

const FALLBACK_AI_RUNTIME_BASE_URL = "http://127.0.0.1:8787";
const THREAD_LIST_EVENT_RELOAD_DELAY_MS = 750;
type RuntimeConversationIdResolver = (threadId: string) => string | null;
const RuntimeConversationIdResolverContext =
    createContext<RuntimeConversationIdResolver>((threadId) =>
        isRuntimeConversationId(threadId) ? threadId : null,
    );

export function AgentAssistantRuntimeProvider({
    children,
}: AgentAssistantRuntimeProviderProps) {
    const endpoint = useAiRuntimeEndpointStore((state) => state.endpoint);
    const runtimeHealthStatus = useAiRuntimeEndpointStore(
        (state) => state.healthStatus,
    );
    const runtimeChecking = useAiRuntimeEndpointStore((state) => state.isChecking);
    const { selectedAgentMode } = useSelectedAiRuntimeAgentMode();
    const { canRun, selectedModel } = useSelectedAiRuntimeModel();
    const backgroundNotifications = useSettingsStore(
        (state) => state.ai.backgroundNotifications,
    );
    const showReplyPreview = useSettingsStore(
        (state) => state.ai.showReplyPreview,
    );
    const notifyOnFailure = useSettingsStore(
        (state) => state.ai.notifyOnFailure,
    );
    const systemNotificationsEnabled = useSettingsStore(
        (state) => state.notification.systemNotificationsEnabled,
    );
    const conversationIdByClientThreadIdRef = useRef(new Map<string, string>());
    const resolveRuntimeConversationId = useCallback<RuntimeConversationIdResolver>(
        (threadId) =>
            resolveConversationIdForClientThread(
                conversationIdByClientThreadIdRef.current,
                threadId,
            ),
        [],
    );
    const activeRunStateRef = useRef(new AgentActiveRunState());
    const pendingReplacementMessageIdRef = useRef<string | null>(null);
    const messageEditController = useMemo<AgentMessageEditController>(
        () => ({
            beginEdit: (messageId) => {
                pendingReplacementMessageIdRef.current = messageId;
            },
            cancelEdit: () => {
                pendingReplacementMessageIdRef.current = null;
            },
        }),
        [],
    );
    const agentRunNotificationPreferences = useMemo<AgentRunNotificationPreferences>(
        () => ({
            systemNotificationsEnabled,
            backgroundNotifications,
            showReplyPreview,
            notifyOnFailure,
        }),
        [
            backgroundNotifications,
            notifyOnFailure,
            showReplyPreview,
            systemNotificationsEnabled,
        ],
    );
    const threadListAdapter = useMemo(
        () =>
            createAiRuntimeThreadListAdapter({
                resolveConversationId: resolveRuntimeConversationId,
                unstableProvider: AiRuntimeThreadRuntimeAdapterProvider,
            }),
        [resolveRuntimeConversationId],
    );
    const selectedRunModel = useMemo<RunModelSelection | null>(() => {
        if (!canRun || !selectedModel) {
            return null;
        }

        return {
            providerId: selectedModel.providerId,
            modelId: selectedModel.modelId,
        };
    }, [canRun, selectedModel]);
    const attachmentAdapter = useMemo(
        () => new RuntimeAttachmentAdapter({
            baseUrl: endpoint?.baseUrl ?? FALLBACK_AI_RUNTIME_BASE_URL,
            accessToken: endpoint?.accessToken ?? null,
            onFirstAdd: () => {
                toast.info(
                    "附件内容会发送给当前选择的外部 AI Provider，并受其数据处理政策约束。",
                );
            },
        }),
        [endpoint?.accessToken, endpoint?.baseUrl],
    );
    const transport = useMemo(
        () =>
            new AssistantChatTransport(
                createAgentRuntimeTransportOptions({
                    baseUrl: endpoint?.baseUrl ?? FALLBACK_AI_RUNTIME_BASE_URL,
                    accessToken: endpoint?.accessToken ?? null,
                    getSelectedModel: () => selectedRunModel,
                    getSelectedAgentMode: () => selectedAgentMode,
                    getConversationId: ({ clientThreadId }) =>
                        clientThreadId
                            ? resolveRuntimeConversationId(clientThreadId)
                            : null,
                    consumeReplacementMessageId: () => {
                        const messageId = pendingReplacementMessageIdRef.current;
                        pendingReplacementMessageIdRef.current = null;
                        return messageId;
                    },
                    getActiveRunId: ({ clientThreadId }) =>
                        activeRunStateRef.current.getRunId({
                            clientThreadId,
                            conversationId: clientThreadId
                                ? resolveRuntimeConversationId(clientThreadId)
                                : null,
                        }),
                    onRuntimeResponse: ({ conversationId, runId, clientThreadId }) => {
                        if (conversationId && clientThreadId) {
                            conversationIdByClientThreadIdRef.current.set(
                                clientThreadId,
                                conversationId,
                            );
                        }
                        activeRunStateRef.current.record({
                            clientThreadId,
                            conversationId,
                            runId,
                        });
                        useAgentStatusSnapshotStore
                            .getState()
                            .setActiveRunCloseSnapshot({ conversationId, runId });
                    },
                    onRequestAdapterError: (message) => {
                        toast.info(message);
                    },
                }),
            ),
        [
            endpoint?.accessToken,
            endpoint?.baseUrl,
            resolveRuntimeConversationId,
            selectedAgentMode,
            selectedRunModel,
        ],
    );
    const runtime = useRemoteThreadListRuntime({
        adapter: threadListAdapter,
        runtimeHook: () =>
            useChatRuntime({
                transport,
                adapters: { attachments: attachmentAdapter },
                sendAutomaticallyWhen:
                    lastAssistantMessageIsCompleteWithApprovalResponses,
                isSendDisabled: shouldDisableAgentRuntimeSend({
                    selectedModel: selectedRunModel,
                    runtimeHealthStatus,
                    runtimeChecking,
                }),
            }),
    });

    return (
        <RuntimeConversationIdResolverContext.Provider
            value={resolveRuntimeConversationId}
        >
            <AssistantRuntimeProvider runtime={runtime}>
                <AgentToolPermissionProvider
                    baseUrl={endpoint?.baseUrl ?? FALLBACK_AI_RUNTIME_BASE_URL}
                    accessToken={endpoint?.accessToken ?? null}
                >
                  <AgentMessageEditProvider controller={messageEditController}>
                    <AgentRuntimeInterruptProvider activeRunStateRef={activeRunStateRef}>
                        <AgentConversationStartupController />
                        <AgentStatusSnapshotReporter />
                        <AgentRuntimeEventInvalidator
                            baseUrl={endpoint?.baseUrl ?? FALLBACK_AI_RUNTIME_BASE_URL}
                            accessToken={endpoint?.accessToken ?? null}
                            activeRunStateRef={activeRunStateRef}
                            resolveRuntimeConversationId={resolveRuntimeConversationId}
                            agentRunNotificationPreferences={agentRunNotificationPreferences}
                        />
                        {children}
                    </AgentRuntimeInterruptProvider>
                  </AgentMessageEditProvider>
                </AgentToolPermissionProvider>
            </AssistantRuntimeProvider>
        </RuntimeConversationIdResolverContext.Provider>
    );
}

function AgentConversationStartupController() {
    const aui = useAui();
    const startupConversation = useSettingsStore(
        (state) => state.ai.startupConversation,
    );
    const lastOpenedConversationId = useSettingsStore(
        (state) => state.ai.lastOpenedConversationId,
    );
    const setLastOpenedConversationId = useSettingsStore(
        (state) => state.setLastOpenedConversationId,
    );
    const threadItems = useAuiState((state) => state.threads.threadItems);
    const threadsLoading = useAuiState((state) => state.threads.isLoading);
    const currentRemoteId = useAuiState(
        (state) => state.threadListItem?.remoteId ?? null,
    );
    const hasAppliedStartupOptionRef = useRef(false);
    const [hasResolvedStartup, setHasResolvedStartup] = useState(false);

    useEffect(() => {
        if (threadsLoading || hasAppliedStartupOptionRef.current) {
            return;
        }

        hasAppliedStartupOptionRef.current = true;
        let disposed = false;

        void (async () => {
            const threadToRestore =
                startupConversation === "restore-last" && lastOpenedConversationId
                    ? threadItems.find(
                        (item) =>
                            item.remoteId === lastOpenedConversationId &&
                            item.status !== "archived",
                    )
                    : undefined;

            if (threadToRestore) {
                await aui.threads().switchToThread(threadToRestore.id);
            } else {
                await aui.threads().switchToNewThread();
            }

            if (!disposed) {
                setHasResolvedStartup(true);
            }
        })().catch((error: unknown) => {
            if (import.meta.env.DEV) {
                console.error(
                    "[AgentConversationStartupController] startup selection failed",
                    error,
                );
            }
            if (!disposed) {
                setHasResolvedStartup(true);
            }
        });

        return () => {
            disposed = true;
        };
    }, [
        aui,
        lastOpenedConversationId,
        startupConversation,
        threadItems,
        threadsLoading,
    ]);

    useEffect(() => {
        if (
            !hasResolvedStartup ||
            !isRuntimeConversationId(currentRemoteId) ||
            currentRemoteId === lastOpenedConversationId
        ) {
            return;
        }

        setLastOpenedConversationId(currentRemoteId);
    }, [
        currentRemoteId,
        hasResolvedStartup,
        lastOpenedConversationId,
        setLastOpenedConversationId,
    ]);

    return null;
}

function AgentRuntimeEventInvalidator({
    baseUrl,
    accessToken,
    activeRunStateRef,
    resolveRuntimeConversationId,
    agentRunNotificationPreferences,
}: {
    baseUrl: string;
    accessToken: string | null;
    activeRunStateRef: MutableRefObject<AgentActiveRunState>;
    resolveRuntimeConversationId: RuntimeConversationIdResolver;
    agentRunNotificationPreferences: AgentRunNotificationPreferences;
}) {
    const aui = useAui();
    const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingHistoryScopeRef = useRef(createEmptyPendingHistoryScope());
    const handledRunNotificationKeysRef = useRef(new Set<string>());

    useEffect(() => {
        const scheduleReload = (event: AiRuntimeEventEnvelope) => {
            queueAgentRunNotification({
                event,
                activeRunState: activeRunStateRef.current,
                preferences: agentRunNotificationPreferences,
                handledKeys: handledRunNotificationKeysRef.current,
            });
            clearTerminalActiveRun(activeRunStateRef.current, event);
            clearTerminalAgentRunCloseSnapshot(event);
            markPendingHistoryScope(pendingHistoryScopeRef.current, event);

            if (reloadTimerRef.current) {
                return;
            }

            reloadTimerRef.current = setTimeout(() => {
                reloadTimerRef.current = null;
                const pendingHistoryScope = pendingHistoryScopeRef.current;
                pendingHistoryScopeRef.current = createEmptyPendingHistoryScope();

                void reloadRuntimeSnapshots(
                    aui,
                    pendingHistoryScope,
                    resolveRuntimeConversationId,
                ).catch((error) => {
                    if (import.meta.env.DEV) {
                        console.error(
                            "[AgentRuntimeEventInvalidator] snapshot reload failed",
                            error,
                        );
                    }
                });
            }, THREAD_LIST_EVENT_RELOAD_DELAY_MS);
        };

        const unsubscribe = subscribeAiRuntimeEvents({
            baseUrl,
            accessToken,
            onEvent: scheduleReload,
            onError: (error) => {
                if (import.meta.env.DEV) {
                    console.error("[AgentRuntimeEventInvalidator] subscribe failed", error);
                }
            },
        });

        return () => {
            unsubscribe();
            if (reloadTimerRef.current) {
                clearTimeout(reloadTimerRef.current);
                reloadTimerRef.current = null;
            }
            pendingHistoryScopeRef.current = createEmptyPendingHistoryScope();
        };
    }, [
        accessToken,
        activeRunStateRef,
        agentRunNotificationPreferences,
        aui,
        baseUrl,
        resolveRuntimeConversationId,
    ]);

    return null;
}

function queueAgentRunNotification(input: {
    event: AiRuntimeEventEnvelope;
    activeRunState: AgentActiveRunState;
    preferences: AgentRunNotificationPreferences;
    handledKeys: Set<string>;
}): void {
    const candidate = getAgentRunNotificationCandidate(input.event);
    if (
        !candidate ||
        !input.activeRunState.hasRunId(candidate.runId) ||
        input.handledKeys.has(candidate.key)
    ) {
        return;
    }

    input.handledKeys.add(candidate.key);
    void dispatchAgentRunNotification({
        candidate,
        preferences: input.preferences,
    }).catch((error: unknown) => {
        if (import.meta.env.DEV) {
            console.error("[AgentRuntimeEventInvalidator] notification dispatch failed", {
                candidate,
                error,
            });
        }
    });
}

function clearTerminalActiveRun(
    activeRunState: AgentActiveRunState,
    event: AiRuntimeEventEnvelope,
): void {
    if (event.type !== "run.updated" || event.scope.kind !== "run") {
        return;
    }

    const run = readRecord(readRecord(event.payload.event)?.properties)?.info;
    if (!isTerminalRunRecord(run)) {
        return;
    }

    activeRunState.clear({
        conversationId:
            typeof run.conversationId === "string" ? run.conversationId : null,
        runId: event.scope.run_id,
    });
}

function clearTerminalAgentRunCloseSnapshot(
    event: AiRuntimeEventEnvelope,
): void {
    if (event.type !== "run.updated" || event.scope.kind !== "run") {
        return;
    }

    const run = readRecord(readRecord(event.payload.event)?.properties)?.info;
    if (!isTerminalRunRecord(run)) {
        return;
    }

    useAgentStatusSnapshotStore.getState().clearActiveRunCloseSnapshot({
        conversationId:
            typeof run.conversationId === "string" ? run.conversationId : null,
        runId: event.scope.run_id,
    });
}

function isTerminalRunRecord(value: unknown): value is {
    conversationId?: string;
    status?: string;
} {
    const record = readRecord(value);
    return (
        record?.status === "completed" ||
        record?.status === "failed" ||
        record?.status === "interrupted"
    );
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

interface PendingHistoryScope {
    global: boolean;
    conversationIds: Set<string>;
    titleConversationIds: Set<string>;
}

function createEmptyPendingHistoryScope(): PendingHistoryScope {
    return {
        global: false,
        conversationIds: new Set<string>(),
        titleConversationIds: new Set<string>(),
    };
}

function markPendingHistoryScope(
    pending: PendingHistoryScope,
    event: AiRuntimeEventEnvelope,
): void {
    if (
        event.type === "conversation.updated" &&
        event.scope.kind === "conversation"
    ) {
        pending.titleConversationIds.add(event.scope.conversation_id);
    }

    if (event.scope.kind === "global") {
        pending.global = true;
        return;
    }

    if (event.scope.kind === "conversation") {
        pending.conversationIds.add(event.scope.conversation_id);
        return;
    }

    if (event.scope.conversation_id) {
        pending.conversationIds.add(event.scope.conversation_id);
        return;
    }

    pending.global = true;
}

async function reloadRuntimeSnapshots(
    aui: ReturnType<typeof useAui>,
    pendingHistoryScope: PendingHistoryScope,
    resolveRuntimeConversationId: RuntimeConversationIdResolver,
): Promise<void> {
    await aui.threads().reload();

    const conversationId = getCurrentRuntimeConversationId(
        aui,
        resolveRuntimeConversationId,
    );
    if (!conversationId) {
        return;
    }

    if (pendingHistoryScope.titleConversationIds.has(conversationId)) {
        await aui.threadListItem().generateTitle();
    }

    if (
        !pendingHistoryScope.global &&
        !pendingHistoryScope.conversationIds.has(conversationId)
    ) {
        return;
    }

    const thread = aui.thread();
    if (thread.getState().isRunning) {
        return;
    }

    const threadRuntime = thread.__internal_getRuntime?.();
    if (!threadRuntime) {
        return;
    }

    await reloadRuntimeThreadHistorySnapshot({
        conversationId,
        importExternalState: (repository) => {
            threadRuntime.importExternalState(repository);
        },
    });
}

function getCurrentRuntimeConversationId(
    aui: ReturnType<typeof useAui>,
    resolveRuntimeConversationId: RuntimeConversationIdResolver,
): string | null {
    const remoteId = aui.threadListItem().getState().remoteId;
    return remoteId ? resolveRuntimeConversationId(remoteId) : null;
}

function AiRuntimeThreadRuntimeAdapterProvider({
    children,
}: {
    children?: ReactNode;
}) {
    const aui = useAui();
    const resolveRuntimeConversationId = useContext(
        RuntimeConversationIdResolverContext,
    );
    const historyAdapter = useMemo(
        () =>
            createAiRuntimeHistoryAdapter({
                getConversationId: () => {
                    const remoteId = aui.threadListItem().getState().remoteId;
                    return remoteId
                        ? resolveRuntimeConversationId(remoteId)
                        : null;
                },
            }),
        [aui, resolveRuntimeConversationId],
    );

    return (
        <RuntimeAdapterProvider
            adapters={{
                history: historyAdapter,
            }}
        >
            {children}
        </RuntimeAdapterProvider>
    );
}

function resolveConversationIdForClientThread(
    conversationIdByClientThreadId: ReadonlyMap<string, string>,
    clientThreadId: string | null | undefined,
): string | null {
    if (!clientThreadId) {
        return null;
    }

    if (isRuntimeConversationId(clientThreadId)) {
        return clientThreadId;
    }

    return conversationIdByClientThreadId.get(clientThreadId) ?? null;
}
