import { useCallback, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { useWorkbenchTabsStore, type WorkbenchTab } from "@/store";
import { expandContentTabClosingSet } from "@/features/workbench/content/content-tab-lifecycle-registry";
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

export type WorkbenchTabCloseSource =
    | "tab-close-button"
    | "tab-context-menu"
    | "tab-middle-click";

export type WorkbenchTabCloseScope = "single" | "others" | "right" | "all";

interface WorkbenchTabCloseRequest {
    source: WorkbenchTabCloseSource;
    scope: WorkbenchTabCloseScope;
    triggerTabId?: string;
    tabs: WorkbenchTab[];
}

interface PendingCloseConfirmation {
    request: WorkbenchTabCloseRequest;
    resolve: (confirmed: boolean) => void;
}

function getVisibleOrderedTabs(tabs: WorkbenchTab[]) {
    return [
        ...tabs.filter((tab) => tab.isPinned),
        ...tabs.filter((tab) => !tab.isPinned),
    ];
}

/**
 * 标签页关闭前检查钩子。
 *
 * 用途：
 * 1. 标签页“叉”按钮、鼠标中键、右键菜单触发的关闭请求，都必须先经过这里。
 * 2. 后续可在这里接入“未保存修改确认”“任务执行中确认”“关闭前保存”等检查逻辑。
 * 3. 该钩子只处理用户发起的关闭请求；系统固定标签页由 store 层继续保护，不受批量关闭影响。
 */
export function useWorkbenchTabCloseGuard() {
    const [pendingConfirmation, setPendingConfirmation] =
        useState<PendingCloseConfirmation | null>(null);
    const {
        tabs,
        closeTab,
        closeOtherTabs,
        closeTabsToRight,
        closeAllTabs,
    } = useWorkbenchTabsStore();

    const dirtyTabs = pendingConfirmation?.request.tabs.filter((tab) => tab.isDirty) ?? [];
    const dirtyTitlePreview = useMemo(() => {
        const titles = dirtyTabs.slice(0, 3).map((tab) => `「${tab.title}」`);
        if (dirtyTabs.length > 3) {
            titles.push(`等 ${dirtyTabs.length} 个标签页`);
        }
        return titles.join("、");
    }, [dirtyTabs]);

    const resolvePendingConfirmation = useCallback(
        (confirmed: boolean) => {
            const pending = pendingConfirmation;
            if (!pending) return;
            setPendingConfirmation(null);
            pending.resolve(confirmed);
        },
        [pendingConfirmation],
    );

    /**
     * 关闭前统一检查入口。
     *
     * 当前版本会拦截带未保存修改的标签页；后续完善关闭检查逻辑时，
     * 请优先修改这里，避免右键菜单和标签页“叉”按钮出现不一致的关闭行为。
     */
    const confirmBeforeClose = useCallback(
        async (request: WorkbenchTabCloseRequest): Promise<boolean> => {
            if (!request.tabs.some((tab) => tab.isDirty)) return true;

            return new Promise<boolean>((resolve) => {
                setPendingConfirmation({ request, resolve });
            });
        },
        [],
    );

    const requestCloseTab = useCallback(
        async (tabId: string, source: WorkbenchTabCloseSource) => {
            const targetTab = tabs.find((tab) => tab.id === tabId);
            if (!targetTab || targetTab.isPinned) return;
            const targetTabs = expandContentTabClosingSet(tabs, [tabId]);

            const canClose = await confirmBeforeClose({
                source,
                scope: "single",
                triggerTabId: tabId,
                tabs: targetTabs,
            });
            if (!canClose) return;

            closeTab(tabId);
        },
        [closeTab, confirmBeforeClose, tabs],
    );

    const requestCloseOtherTabs = useCallback(
        async (tabId: string) => {
            const requestedTabs = tabs.filter((tab) => tab.id !== tabId && !tab.isPinned);
            const targetTabs = expandContentTabClosingSet(
                tabs,
                requestedTabs.map((tab) => tab.id),
            );
            if (targetTabs.length === 0) return;

            const canClose = await confirmBeforeClose({
                source: "tab-context-menu",
                scope: "others",
                triggerTabId: tabId,
                tabs: targetTabs,
            });
            if (!canClose) return;

            closeOtherTabs(tabId);
        },
        [closeOtherTabs, confirmBeforeClose, tabs],
    );

    const requestCloseTabsToRight = useCallback(
        async (tabId: string) => {
            const visibleOrderedTabs = getVisibleOrderedTabs(tabs);
            const tabIndex = visibleOrderedTabs.findIndex((tab) => tab.id === tabId);
            if (tabIndex === -1) return;

            const requestedTabs = visibleOrderedTabs
                .slice(tabIndex + 1)
                .filter((tab) => !tab.isPinned);
            const targetTabs = expandContentTabClosingSet(
                tabs,
                requestedTabs.map((tab) => tab.id),
            );
            if (targetTabs.length === 0) return;

            const canClose = await confirmBeforeClose({
                source: "tab-context-menu",
                scope: "right",
                triggerTabId: tabId,
                tabs: targetTabs,
            });
            if (!canClose) return;

            closeTabsToRight(tabId);
        },
        [closeTabsToRight, confirmBeforeClose, tabs],
    );

    const requestCloseAllTabs = useCallback(async () => {
        const targetTabs = expandContentTabClosingSet(
            tabs,
            tabs.filter((tab) => !tab.isPinned).map((tab) => tab.id),
        );
        if (targetTabs.length === 0) return;

        const canClose = await confirmBeforeClose({
            source: "tab-context-menu",
            scope: "all",
            tabs: targetTabs,
        });
        if (!canClose) return;

        closeAllTabs();
    }, [closeAllTabs, confirmBeforeClose, tabs]);

    const closeConfirmationDialog = (
        <AlertDialog
            open={pendingConfirmation != null}
            onOpenChange={(open) => {
                if (!open) resolvePendingConfirmation(false);
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogMedia className="bg-amber-500/10 text-amber-600">
                        <AlertTriangle className="size-5" />
                    </AlertDialogMedia>
                    <AlertDialogTitle>丢弃未保存修改？</AlertDialogTitle>
                    <AlertDialogDescription>
                        {dirtyTabs.length === 1
                            ? `${dirtyTitlePreview} 存在未保存修改，关闭后这些修改会被丢弃。`
                            : `${dirtyTitlePreview} 存在未保存修改，关闭后这些修改会被丢弃。`}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={() => resolvePendingConfirmation(false)}>
                        取消
                    </AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        onClick={() => resolvePendingConfirmation(true)}
                    >
                        丢弃并关闭
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );

    return {
        requestCloseTab,
        requestCloseOtherTabs,
        requestCloseTabsToRight,
        requestCloseAllTabs,
        closeConfirmationDialog,
    };
}
