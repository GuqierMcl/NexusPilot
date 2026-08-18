import { PanelLeftClose, PanelLeftOpen, PanelRightClose } from "lucide-react";
import { PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccountTrigger } from "@/features/account/components/account-trigger";
// import { Separator } from "@/components/ui/separator";
import { ModeToggle } from "./mode-toggle";
// import {
//     Avatar,
//     AvatarFallback,
//     AvatarImage,
//     AvatarBadge,
// } from "@/components/ui/avatar";
import { useWorkspaceLayoutStore } from "@/store";

interface TitleActionsProps {
    onCloudSettingsRequested?: () => void;
}

export function TitleActions({ onCloudSettingsRequested }: TitleActionsProps) {
    const isLeftCollapsed = useWorkspaceLayoutStore((s) => s.isLeftSidebarCollapsed);
    const isRightCollapsed = useWorkspaceLayoutStore((s) => s.isRightSidebarCollapsed);
    const toggleLeft = useWorkspaceLayoutStore((s) => s.toggleLeftSidebar);
    const toggleRight = useWorkspaceLayoutStore((s) => s.toggleRightSidebar);

    return (
        <>
            <Button
                variant="ghost"
                size="icon"
                title={isLeftCollapsed ? "展开左侧栏" : "折叠左侧栏"}
                aria-label={isLeftCollapsed ? "展开左侧栏" : "折叠左侧栏"}
                onClick={toggleLeft}
            >
                {!isLeftCollapsed ? <PanelLeftClose className="size-3.5" /> : <PanelLeftOpen className="size-3.5" />}
            </Button>
            <Button
                variant="ghost"
                size="icon"
                title={isRightCollapsed ? "展开右侧栏" : "折叠右侧栏"}
                aria-label={isRightCollapsed ? "展开右侧栏" : "折叠右侧栏"}
                onClick={toggleRight}
            >
                {!isRightCollapsed ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
            </Button>

            {/* <Separator orientation="vertical" className="my-1" /> */}

            <ModeToggle />
            <AccountTrigger onCloudSettingsRequested={onCloudSettingsRequested} />
            {/* <Avatar size="sm">
                <AvatarImage
                    src="https://github.com/shadcn.png"
                    alt="@shadcn"
                    className="grayscale"
                />
                <AvatarFallback>CN</AvatarFallback>
                <AvatarBadge className="bg-green-600 dark:bg-green-800" />
            </Avatar> */}
        </>
    );
}
