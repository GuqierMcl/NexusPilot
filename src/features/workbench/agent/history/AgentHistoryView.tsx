"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
    AlertCircle,
    Archive,
    ArchiveRestore,
    CheckCircle2,
    Clock3,
    Loader2,
    MessageSquare,
    MoreHorizontal,
    Pencil,
    Pin,
    PinOff,
    Square,
    Trash2,
} from "lucide-react";
import { toast } from "@/components/ui/toast";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useAgentRuntimeInterruptController } from "@/features/workbench/agent/runtime/run-interrupt-context";
import {
    pinRuntimeConversation,
    unpinRuntimeConversation,
} from "@/lib/ai-runtime/conversations";
import { cn } from "@/lib/utils";

import {
    canSwitchToAgentHistoryItem,
    createAgentHistoryGroups,
    type AgentHistoryItemViewModel,
    type AgentHistoryThreadItemLike,
} from "./agent-history-view-model";
import { deleteAgentHistoryItem } from "./agent-history-actions";

interface AgentHistoryViewProps {
    onConversationSelected: () => void;
}

export function AgentHistoryView({ onConversationSelected }: AgentHistoryViewProps) {
    const aui = useAui();
    const interrupt = useAgentRuntimeInterruptController();
    const [reloadError, setReloadError] = useState<string | null>(null);
    const [switchingThreadId, setSwitchingThreadId] = useState<string | null>(null);
    const [interruptingConversationId, setInterruptingConversationId] = useState<string | null>(null);
    const [archivedOpen, setArchivedOpen] = useState(false);
    const [renamingItem, setRenamingItem] = useState<AgentHistoryItemViewModel | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [deleteTarget, setDeleteTarget] = useState<AgentHistoryItemViewModel | null>(null);
    const [pendingActionId, setPendingActionId] = useState<string | null>(null);
    const threadItems = useAuiState(
        (state) =>
            state.threads.threadItems as readonly AgentHistoryThreadItemLike[],
    );
    const mainThreadId = useAuiState((state) => state.threads.mainThreadId);
    const isThreadListLoading = useAuiState(
        (state) => state.threads.isLoading,
    );
    const currentThreadIsRunning = useAuiState(
        (state) => state.thread.isRunning,
    );

    useEffect(() => {
        let disposed = false;

        void aui
            .threads()
            .reload()
            .then(() => {
                if (!disposed) {
                    setReloadError(null);
                }
            })
            .catch((error: unknown) => {
                if (!disposed) {
                    setReloadError(
                        error instanceof Error ? error.message : String(error),
                    );
                }
            });

        return () => {
            disposed = true;
        };
    }, [aui]);

    const groups = useMemo(
        () =>
            createAgentHistoryGroups({
                threadItems,
                mainThreadId,
                currentThreadIsRunning,
            }),
        [currentThreadIsRunning, mainThreadId, threadItems],
    );
    const hasHistoryItems = groups.regular.length > 0 || groups.archived.length > 0;

    const reloadThreads = async () => {
        await aui.threads().reload();
    };

    const handleSelect = async (item: AgentHistoryItemViewModel) => {
        if (!canSwitchToAgentHistoryItem(item)) {
            return;
        }

        if (item.active) {
            onConversationSelected();
            return;
        }

        setSwitchingThreadId(item.id);
        try {
            await aui.threads().switchToThread(item.id);
            onConversationSelected();
        } finally {
            setSwitchingThreadId(null);
        }
    };

    const handleInterrupt = async (item: AgentHistoryItemViewModel) => {
        if (!item.remoteId || !item.canInterrupt) {
            return;
        }

        setInterruptingConversationId(item.remoteId);
        try {
            await interrupt.interruptConversation({
                conversationId: item.remoteId,
                message: "user requested stop from history",
            });
            await reloadThreads();
        } finally {
            setInterruptingConversationId(null);
        }
    };

    const openRename = (item: AgentHistoryItemViewModel) => {
        setRenamingItem(item);
        setRenameValue(item.title);
    };

    const saveRename = async () => {
        if (!renamingItem) {
            return;
        }

        const title = renameValue.trim();
        if (!title) {
            toast.error("对话名称不能为空");
            return;
        }

        if (title === renamingItem.title) {
            cancelRename();
            return;
        }

        setPendingActionId(renamingItem.id);
        try {
            await aui.threads().item({ id: renamingItem.id }).rename(title);
            await reloadThreads();
            cancelRename();
        } finally {
            setPendingActionId(null);
        }
    };

    const cancelRename = () => {
        setRenamingItem(null);
        setRenameValue("");
    };

    const handlePinToggle = async (item: AgentHistoryItemViewModel) => {
        if (!item.remoteId) {
            return;
        }

        setPendingActionId(item.id);
        try {
            if (item.pinned) {
                await unpinRuntimeConversation(item.remoteId);
            } else {
                await pinRuntimeConversation(item.remoteId);
            }
            await reloadThreads();
        } finally {
            setPendingActionId(null);
        }
    };

    const handleArchiveToggle = async (item: AgentHistoryItemViewModel) => {
        setPendingActionId(item.id);
        try {
            const runtimeItem = aui.threads().item({ id: item.id });
            if (item.archived) {
                await runtimeItem.unarchive();
            } else {
                await runtimeItem.archive();
                if (item.active) {
                    await aui.threads().switchToNewThread();
                    onConversationSelected();
                }
            }
            await reloadThreads();
        } finally {
            setPendingActionId(null);
        }
    };

    const handleDeleteConfirmed = async () => {
        const item = deleteTarget;
        if (!item?.remoteId) {
            return;
        }

        setPendingActionId(item.id);
        try {
            await deleteAgentHistoryItem({
                item,
                deleteThread: async (threadId) => {
                    await aui.threads().item({ id: threadId }).delete();
                },
                switchToNewThread: async () => {
                    await aui.threads().switchToNewThread();
                },
                reloadThreads,
                onConversationSelected,
            });
            setDeleteTarget(null);
        } finally {
            setPendingActionId(null);
        }
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
            <div className="shrink-0 border-b px-3 py-2">
                <div className="flex items-center gap-2">
                    <MessageSquare className="size-4 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">历史对话</div>
                    </div>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                            void reloadThreads();
                        }}
                    >
                        刷新
                    </Button>
                </div>
            </div>

            {currentThreadIsRunning ? (
                <div className="mx-3 mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
                    当前对话正在生成，完成或停止后可切换到其他历史对话。
                </div>
            ) : null}

            {reloadError ? (
                <AgentHistoryStateMessage
                    icon={<AlertCircle className="size-4" />}
                    title="历史对话加载失败"
                    description={reloadError}
                />
            ) : isThreadListLoading && !hasHistoryItems ? (
                <AgentHistoryStateMessage
                    icon={<Loader2 className="size-4 animate-spin" />}
                    title="正在加载历史对话"
                    description="正在从 AI Runtime 读取对话快照。"
                />
            ) : !hasHistoryItems ? (
                <AgentHistoryStateMessage
                    icon={<MessageSquare className="size-4" />}
                    title="暂无历史对话"
                    description="发送第一条消息后，对话会出现在这里。"
                />
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {groups.regular.length > 0 ? (
                        <div className="space-y-1">
                            {groups.regular.map((item) => (
                                <AgentHistoryListItem
                                    key={item.id}
                                    item={item}
                                    switching={switchingThreadId === item.id}
                                    interrupting={interruptingConversationId === item.remoteId}
                                    pending={pendingActionId === item.id}
                                    renaming={renamingItem?.id === item.id}
                                    renameValue={renameValue}
                                    onRenameValueChange={setRenameValue}
                                    onRenameSave={() => {
                                        void saveRename();
                                    }}
                                    onRenameCancel={cancelRename}
                                    onSelect={() => {
                                        void handleSelect(item);
                                    }}
                                    onInterrupt={() => {
                                        void handleInterrupt(item);
                                    }}
                                    onRename={() => openRename(item)}
                                    onPinToggle={() => {
                                        void handlePinToggle(item);
                                    }}
                                    onArchiveToggle={() => {
                                        void handleArchiveToggle(item);
                                    }}
                                    onDelete={() => setDeleteTarget(item)}
                                />
                            ))}
                        </div>
                    ) : null}

                    {groups.archived.length > 0 ? (
                        <div className="mt-3 border-t pt-2">
                            <button
                                type="button"
                                className="flex h-8 w-full items-center justify-between rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                                onClick={() => setArchivedOpen((open) => !open)}
                            >
                                <span>已归档</span>
                                <span>{groups.archived.length}</span>
                            </button>
                            {archivedOpen ? (
                                <div className="mt-1 space-y-1">
                                    {groups.archived.map((item) => (
                                        <AgentHistoryListItem
                                            key={item.id}
                                            item={item}
                                            switching={switchingThreadId === item.id}
                                            interrupting={interruptingConversationId === item.remoteId}
                                            pending={pendingActionId === item.id}
                                            renaming={renamingItem?.id === item.id}
                                            renameValue={renameValue}
                                            onRenameValueChange={setRenameValue}
                                            onRenameSave={() => {
                                                void saveRename();
                                            }}
                                            onRenameCancel={cancelRename}
                                            onSelect={() => {
                                                void handleSelect(item);
                                            }}
                                            onInterrupt={() => {
                                                void handleInterrupt(item);
                                            }}
                                            onRename={() => openRename(item)}
                                            onPinToggle={() => {
                                                void handlePinToggle(item);
                                            }}
                                            onArchiveToggle={() => {
                                                void handleArchiveToggle(item);
                                            }}
                                            onDelete={() => setDeleteTarget(item)}
                                        />
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            )}

            <AlertDialog
                open={deleteTarget !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setDeleteTarget(null);
                    }
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>删除对话？</AlertDialogTitle>
                        <AlertDialogDescription>
                            删除后将永久移除此对话及其消息记录，此操作无法撤销。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={pendingActionId === deleteTarget?.id}
                            onClick={() => {
                                void handleDeleteConfirmed();
                            }}
                        >
                            删除
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

function AgentHistoryListItem({
    item,
    switching,
    interrupting,
    pending,
    renaming,
    renameValue,
    onRenameValueChange,
    onRenameSave,
    onRenameCancel,
    onSelect,
    onInterrupt,
    onRename,
    onPinToggle,
    onArchiveToggle,
    onDelete,
}: {
    item: AgentHistoryItemViewModel;
    switching: boolean;
    interrupting: boolean;
    pending: boolean;
    renaming: boolean;
    renameValue: string;
    onRenameValueChange: (value: string) => void;
    onRenameSave: () => void;
    onRenameCancel: () => void;
    onSelect: () => void;
    onInterrupt: () => void;
    onRename: () => void;
    onPinToggle: () => void;
    onArchiveToggle: () => void;
    onDelete: () => void;
}) {
    const disabled = item.disabled || switching || pending;
    const mutationBlocked =
        item.runtimeStatusType === "busy" ||
        item.runtimeStatusType === "waiting_for_permission";
    const statusIcon = switching || pending ? (
        <Loader2 className="size-4 animate-spin" />
    ) : item.active ? (
        <CheckCircle2 className="size-4 text-primary" />
    ) : (
        <Clock3 className="size-4" />
    );
    const metadata = (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">{item.statusLabel}</span>
            <span className="min-w-0 truncate">{item.updatedAtLabel}</span>
        </div>
    );

    return (
        <div
            className={cn(
                "group flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
                item.active
                    ? "border-primary/30 bg-primary/5"
                    : "border-transparent hover:border-border hover:bg-muted/60",
                disabled &&
                    "cursor-not-allowed opacity-60 hover:border-transparent hover:bg-transparent",
            )}
        >
            {renaming ? (
                <div className="flex min-w-0 flex-1 items-start gap-2 text-left">
                    <div className="mt-0.5 shrink-0 text-muted-foreground">
                        {statusIcon}
                    </div>
                    <div className="min-w-0 flex-1">
                        <Input
                            value={renameValue}
                            className="h-7 text-sm"
                            autoFocus
                            disabled={pending}
                            onChange={(event) => onRenameValueChange(event.target.value)}
                            onBlur={onRenameSave}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    onRenameSave();
                                }
                                if (event.key === "Escape") {
                                    event.preventDefault();
                                    onRenameCancel();
                                }
                            }}
                        />
                        {metadata}
                    </div>
                </div>
            ) : (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={onSelect}
                    className="flex min-w-0 flex-1 items-start gap-2 text-left outline-none"
                >
                    <div className="mt-0.5 shrink-0 text-muted-foreground">
                        {statusIcon}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                            {item.pinned && !item.archived ? (
                                <Pin className="size-3 shrink-0 text-primary" />
                            ) : null}
                            <div className="truncate text-sm font-medium">{item.title}</div>
                        </div>
                        {metadata}
                    </div>
                </button>
            )}
            {item.canInterrupt ? (
                <button
                    type="button"
                    disabled={interrupting}
                    aria-label="停止该对话"
                    title="停止该对话"
                    className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    onClick={(event) => {
                        event.stopPropagation();
                        onInterrupt();
                    }}
                >
                    {interrupting ? (
                        <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                        <Square className="size-3.5 fill-current" />
                    )}
                </button>
            ) : null}
            <DropdownMenu>
                <DropdownMenuTrigger
                    render={<button
                        type="button"
                        disabled={pending}
                        aria-label="更多对话操作"
                        title="更多对话操作"
                        className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <MoreHorizontal className="size-3.5" />
                    </button>}
                />
                <DropdownMenuContent align="end" className="w-36">
                    {!item.archived ? (
                        <DropdownMenuItem onClick={onPinToggle}>
                            {item.pinned ? (
                                <PinOff className="size-4" />
                            ) : (
                                <Pin className="size-4" />
                            )}
                            {item.pinned ? "取消置顶" : "置顶"}
                        </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onClick={onRename}>
                        <Pencil className="size-4" />
                        重命名
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        disabled={mutationBlocked}
                        onClick={onArchiveToggle}
                    >
                        {item.archived ? (
                            <ArchiveRestore className="size-4" />
                        ) : (
                            <Archive className="size-4" />
                        )}
                        {item.archived ? "取消归档" : "归档"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        variant="destructive"
                        disabled={mutationBlocked}
                        onClick={onDelete}
                    >
                        <Trash2 className="size-4" />
                        删除
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

function AgentHistoryStateMessage({
    icon,
    title,
    description,
}: {
    icon: ReactNode;
    title: string;
    description: string;
}) {
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
            <div className="flex max-w-64 flex-col items-center text-center">
                <div className="mb-2 text-muted-foreground">{icon}</div>
                <div className="text-sm font-medium">{title}</div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {description}
                </div>
            </div>
        </div>
    );
}
