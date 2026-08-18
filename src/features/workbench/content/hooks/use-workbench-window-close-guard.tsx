import { useCallback, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogMedia,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    completeWindowClose,
    useWindowCloseGuardWithHandler,
    type CloseRequestedEvent,
} from "@/hooks/use-window-close-guard";
import {
    interruptRuntimeConversationActiveRun,
    interruptRuntimeRun,
} from "@/lib/ai-runtime/run-commands";
import type { AgentRunCloseSnapshot } from "@/features/workbench/agent/state";
import { useAgentStatusSnapshotStore } from "@/features/workbench/agent/state";
import { useWorkbenchTabsStore, type WorkbenchTab } from "@/store";

const AGENT_INTERRUPT_BEFORE_CLOSE_TIMEOUT_MS = 1_500;

interface PendingWindowCloseConfirmation {
    dirtyTabs: WorkbenchTab[];
    executingTabs: WorkbenchTab[];
    activeAgentRun: AgentRunCloseSnapshot | null;
}

function formatTabTitles(tabs: WorkbenchTab[]): string {
    const titles = tabs.slice(0, 3).map((tab) => `「${tab.title}」`);
    if (tabs.length > 3) {
        titles.push(`等 ${tabs.length} 个标签页`);
    }
    return titles.join("、");
}

function buildCloseDescription(
    pending: PendingWindowCloseConfirmation,
): string {
    const parts: string[] = [];

    if (pending.dirtyTabs.length > 0) {
        parts.push(
            `${formatTabTitles(pending.dirtyTabs)}存在未保存修改，关闭后这些修改不会恢复。`,
        );
    }

    if (pending.executingTabs.length > 0) {
        parts.push(
            `${formatTabTitles(pending.executingTabs)}仍在执行，关闭后将无法继续在 NexusPilot 中查看其状态。`,
        );
    }

    if (pending.activeAgentRun) {
        parts.push(
            "AI 正在生成回复。继续关闭会中断本次生成，已生成的部分内容会保留在对话历史中。",
        );
    }

    return parts.join(" ");
}

function getCloseActionLabel(
    pending: PendingWindowCloseConfirmation | null,
): string {
    const hasDirtyTabs = (pending?.dirtyTabs.length ?? 0) > 0;
    const hasActiveAgentRun = pending?.activeAgentRun !== null;

    if (hasDirtyTabs && hasActiveAgentRun) return "丢弃并中断关闭";
    if (hasActiveAgentRun) return "中断并关闭";
    if (hasDirtyTabs) return "丢弃并关闭";
    return "仍然关闭";
}

async function interruptActiveAgentRunBeforeClose(
    activeAgentRun: AgentRunCloseSnapshot,
): Promise<void> {
    const interruptPromise = activeAgentRun.runId
        ? interruptRuntimeRun(activeAgentRun.runId, {
              reason: "client_disconnect",
              message: "应用窗口关闭",
          })
        : activeAgentRun.conversationId
          ? interruptRuntimeConversationActiveRun(activeAgentRun.conversationId, {
                reason: "client_disconnect",
                message: "应用窗口关闭",
            })
          : null;

    if (!interruptPromise) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
        await Promise.race([
            interruptPromise,
            new Promise<void>((resolve) => {
                timeoutId = setTimeout(resolve, AGENT_INTERRUPT_BEFORE_CLOSE_TIMEOUT_MS);
            }),
        ]);
    } catch (error) {
        console.error(
            "[useWorkbenchWindowCloseGuard] interrupting active Agent run before close failed",
            error,
        );
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * 仅在工作台存在未保存修改、运行中任务或活跃 AI Run 时确认关闭窗口。
 * 设置弹窗和设置表单不参与本守卫的风险判断。
 */
export function useWorkbenchWindowCloseGuard() {
    const [pendingConfirmation, setPendingConfirmation] =
        useState<PendingWindowCloseConfirmation | null>(null);
    const [isConfirmingClose, setIsConfirmingClose] = useState(false);
    const hasPendingConfirmationRef = useRef(false);
    const isClosingRef = useRef(false);

    const completeClose = useCallback(() => {
        if (isClosingRef.current) return;

        isClosingRef.current = true;
        hasPendingConfirmationRef.current = false;
        setPendingConfirmation(null);
        void completeWindowClose();
    }, []);

    const handleCloseRequest = useCallback((event: CloseRequestedEvent) => {
        event.preventDefault();

        if (isClosingRef.current || hasPendingConfirmationRef.current) {
            return;
        }

        const tabs = useWorkbenchTabsStore.getState().tabs;
        const dirtyTabs = tabs.filter((tab) => tab.isDirty);
        const executingTabs = tabs.filter((tab) => tab.isExecuting);
        const activeAgentRun =
            useAgentStatusSnapshotStore.getState().activeRunCloseSnapshot;

        if (
            dirtyTabs.length === 0 &&
            executingTabs.length === 0 &&
            !activeAgentRun.isTransportActive
        ) {
            completeClose();
            return;
        }

        hasPendingConfirmationRef.current = true;
        setPendingConfirmation({
            dirtyTabs,
            executingTabs,
            activeAgentRun: activeAgentRun.isTransportActive
                ? activeAgentRun
                : null,
        });
    }, [completeClose]);

    useWindowCloseGuardWithHandler(handleCloseRequest);

    const resolveConfirmation = useCallback((confirmed: boolean) => {
        if (!hasPendingConfirmationRef.current) return;

        hasPendingConfirmationRef.current = false;
        setPendingConfirmation(null);

        if (confirmed) {
            setIsConfirmingClose(true);
            void (async () => {
                if (pendingConfirmation?.activeAgentRun) {
                    await interruptActiveAgentRunBeforeClose(
                        pendingConfirmation.activeAgentRun,
                    );
                }
                completeClose();
            })();
        }
    }, [completeClose, pendingConfirmation]);

    const hasDirtyTabs = (pendingConfirmation?.dirtyTabs.length ?? 0) > 0;
    const hasActiveAgentRun = pendingConfirmation?.activeAgentRun !== null;

    const closeConfirmationDialog = (
        <AlertDialog
            open={pendingConfirmation !== null}
            onOpenChange={(open) => {
                if (!open) resolveConfirmation(false);
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogMedia className="bg-amber-500/10 text-amber-600">
                        <AlertTriangle className="size-5" />
                    </AlertDialogMedia>
                    <AlertDialogTitle>
                        {hasDirtyTabs
                            ? "丢弃未保存修改并关闭？"
                            : hasActiveAgentRun
                              ? "中断 AI 回复并关闭？"
                              : "关闭 NexusPilot？"}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {pendingConfirmation
                            ? buildCloseDescription(pendingConfirmation)
                            : ""}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={() => resolveConfirmation(false)}>
                        取消
                    </AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={isConfirmingClose}
                        onClick={() => resolveConfirmation(true)}
                    >
                        {isConfirmingClose
                            ? "正在关闭…"
                            : getCloseActionLabel(pendingConfirmation)}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );

    return { closeConfirmationDialog };
}
