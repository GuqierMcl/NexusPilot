import { Activity } from "react";
import { LayoutDashboard } from "lucide-react";

import { renderContentTabPanel } from "@/features/workbench/content/content-tab-registry";
import { useWorkbenchTabsStore } from "@/store";

function EmptyTabView() {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="flex size-14 items-center justify-center rounded-xl bg-muted">
                <LayoutDashboard className="size-7 text-muted-foreground" />
            </div>
            <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">工作台</p>
                <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground/60">
                    从左侧连接树中选择表、视图或其他对象，或新建一个查询标签页开始工作。
                </p>
            </div>
        </div>
    );
}

export function ContentTabView() {
    const tabs = useWorkbenchTabsStore((state) => state.tabs);
    const activeTabId = useWorkbenchTabsStore((state) => state.activeTabId);

    if (tabs.length === 0) {
        return (
            <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <EmptyTabView />
            </div>
        );
    }

    return (
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {tabs.map((tab) => (
                <Activity
                    key={tab.id}
                    mode={tab.id === activeTabId ? "visible" : "hidden"}
                >
                    <div className="absolute inset-0 min-w-0 overflow-hidden">
                        {renderContentTabPanel(tab, tab.id === activeTabId)}
                    </div>
                </Activity>
            ))}
        </div>
    );
}
