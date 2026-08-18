import { ContentTabBar } from "@/features/workbench/content/components/ContentTabBar";
import { ContentTabView } from "@/features/workbench/content/components/ContentTabView";
import { ContentToolbar } from "@/features/workbench/content/components/ContentToolbar";
import { WorkbenchStatusOverlayHost } from "@/features/workbench/status-bar/overlays/WorkbenchStatusOverlayHost";

export function WorkbenchContentPanel() {
    return (
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
            {/* 上栏：动态操作/菜单栏（按当前 tab 类型动态展示操作按钮） */}
            <ContentToolbar />

            {/* 下栏（核心）：Tab 标签栏，支持横向滚动 */}
            <ContentTabBar />

            {/* 内容区：基于 React 19 Activity 的多标签面板 */}
            <ContentTabView />
            <WorkbenchStatusOverlayHost />
        </section>
    );
}
