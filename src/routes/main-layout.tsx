import { useEffect, useState } from "react";
import { Layout, useGroupRef } from "react-resizable-panels";

import logoSvg from "@/assets/logo.svg";
import NexusPilotWordmark from "@/assets/nexuspilot-wordmark.svg?react";
import { AppTitleBar } from "@/components/layout/AppTitleBar";
import { NavigationRail } from "@/components/layout/NavigationRail";
import { TitleActions } from "@/components/title-actions";
import { UpdatePrompt } from "@/features/update/UpdatePrompt";
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from "@/components/ui/resizable";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import {
    DEFAULT_SETTINGS_SECTION,
    type SettingsSection,
} from "@/features/settings/settings-sections";
import {
    WorkbenchAgentPanel,
    WorkbenchContentPanel,
    WorkbenchExplorerPanel,
    WorkbenchStatusBar,
} from "@/features/workbench";
import { useWorkspaceLayoutStore } from "@/store/slices/workspace-layout-slice";

/**
 * 主窗口（Main）整页布局：标题栏 + 左侧导航 + 三栏可调整区域。
 * 具体业务内容由 `features/workbench` 提供，布局层仅负责骨架与拼装。
 */
export function MainLayout() {
    const workspaceLayoutStore = useWorkspaceLayoutStore();
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [settingsInitialSection, setSettingsInitialSection] =
        useState<SettingsSection>(DEFAULT_SETTINGS_SECTION);

    const groupRef = useGroupRef();

    const openSettings = (section: SettingsSection = DEFAULT_SETTINGS_SECTION) => {
        setSettingsInitialSection(section);
        setIsSettingsOpen(true);
    };

    const openConnectionsPanel = () => {
        workspaceLayoutStore.setLeftSidebarCollapsed(false);
    };

    useEffect(() => {
        const leftCollapsed = workspaceLayoutStore.isLeftSidebarCollapsed;
        const rightCollapsed = workspaceLayoutStore.isRightSidebarCollapsed;
        const leftWidth = workspaceLayoutStore.leftSidebarWidth as number;
        const rightWidth = workspaceLayoutStore.rightSidebarWidth as number;

        let centerPanelWidth: number;
        if (!leftCollapsed && !rightCollapsed) {
            centerPanelWidth = 100 - leftWidth - rightWidth;
        } else if (leftCollapsed && !rightCollapsed) {
            centerPanelWidth = 100 - rightWidth;
        } else if (!leftCollapsed && rightCollapsed) {
            centerPanelWidth = 100 - leftWidth;
        } else {
            centerPanelWidth = 100;
        }
        groupRef.current?.setLayout({
            leftPanel: leftCollapsed ? 0 : leftWidth,
            centerPanel: centerPanelWidth,
            agentPanel: rightCollapsed ? 0 : rightWidth,
        });
    }, [
        workspaceLayoutStore.isLeftSidebarCollapsed,
        workspaceLayoutStore.isRightSidebarCollapsed,
        workspaceLayoutStore.leftSidebarWidth,
        workspaceLayoutStore.rightSidebarWidth,
    ]);

    const handleLayoutChanged = (layout: Layout) => {
        // 只在未折叠时更新宽度，折叠时不更新宽度
        if (layout.leftPanel > 0) {
            workspaceLayoutStore.setLeftSidebarWidth(layout.leftPanel);
            workspaceLayoutStore.setLeftSidebarCollapsed(false);
        } else {
            workspaceLayoutStore.setLeftSidebarCollapsed(true);
        }
        if (layout.agentPanel > 0) {
            workspaceLayoutStore.setRightSidebarWidth(layout.agentPanel);
            workspaceLayoutStore.setRightSidebarCollapsed(false);
        } else {
            workspaceLayoutStore.setRightSidebarCollapsed(true);
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <AppTitleBar
                titleActions={
                    <TitleActions onCloudSettingsRequested={() => openSettings("cloud")} />
                }
                macosContent={<UpdatePrompt appearance="icon" />}
            >
                <div
                    data-no-drag="true"
                    className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground"
                >
                    <div className="flex shrink-0 items-center gap-2.5">
                        <img
                            src={logoSvg}
                            alt=""
                            className="size-7 shrink-0"
                            draggable={false}
                        />
                        {/* <span className="select-none text-sm font-medium text-foreground">
                            NexusPilot
                        </span> */}
                        <NexusPilotWordmark
                            className="h-4 w-auto shrink-0 select-none text-foreground"
                            aria-label="NexusPilot"
                            focusable={false}
                        />
                        <UpdatePrompt appearance="icon" />
                    </div>
                </div>
            </AppTitleBar>

            <div className="flex min-h-0 flex-1">
                <NavigationRail
                    onConnectionsClick={openConnectionsPanel}
                    onSettingsClick={() => openSettings()}
                />

                <ResizablePanelGroup
                    id="layoutContainer"
                    className="min-w-0 flex-1"
                    orientation="horizontal"
                    groupRef={groupRef}
                    onLayoutChanged={handleLayoutChanged}
                >
                    <ResizablePanel
                        id="leftPanel"
                        defaultSize="30%"
                        minSize="150px"
                        groupResizeBehavior="preserve-pixel-size"
                        collapsible
                    >
                        <WorkbenchExplorerPanel />
                    </ResizablePanel>

                    <ResizableHandle withHandle />

                    <ResizablePanel id="centerPanel" minSize="200px">
                        <WorkbenchContentPanel />
                    </ResizablePanel>

                    <ResizableHandle withHandle />

                    <ResizablePanel
                        id="agentPanel"
                        defaultSize="30%"
                        minSize="135px"
                        groupResizeBehavior="preserve-pixel-size"
                        collapsible
                    >
                        <WorkbenchAgentPanel onSettingsRequested={openSettings} />
                    </ResizablePanel>
                </ResizablePanelGroup>
            </div>

            <WorkbenchStatusBar />

            <SettingsDialog
                open={isSettingsOpen}
                onOpenChange={setIsSettingsOpen}
                initialSection={settingsInitialSection}
            />
        </div>
    );
}
