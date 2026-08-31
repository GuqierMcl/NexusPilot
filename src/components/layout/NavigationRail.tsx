import type { ComponentType, MouseEventHandler } from "react";
import { BookOpen, Boxes, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";

type RailAction = {
    label: string;
    icon: ComponentType<{ className?: string }>;
    isActive?: boolean;
    onClick?: MouseEventHandler<HTMLButtonElement>;
};

const topActions: RailAction[] = [
    { label: "连接列表", icon: Boxes, isActive: true },
];

interface BottomRailActionHandlers {
    onDocumentationClick?: MouseEventHandler<HTMLButtonElement>;
    onSettingsClick?: MouseEventHandler<HTMLButtonElement>;
}

export function createBottomRailActions({
    onDocumentationClick,
    onSettingsClick,
}: BottomRailActionHandlers): RailAction[] {
    return [
        { label: "文档", icon: BookOpen, onClick: onDocumentationClick },
        { label: "设置", icon: Settings, onClick: onSettingsClick },
    ];
}

function RailButton({
    label,
    icon: Icon,
    isActive = false,
    onClick,
}: RailAction) {
    return (
        <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className={
                isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent/90"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            }
            aria-label={label}
            title={label}
            tooltipSide="right"
            onClick={onClick}
        >
            <Icon className="size-4" />
            <span className="sr-only">{label}</span>
        </Button>
    );
}

function RailGroup({ actions }: { actions: RailAction[] }) {
    if (actions.length === 0) return null;
    return (
        <div className="flex flex-col items-center gap-2 px-2 py-3">
            {actions.map((action) => (
                <RailButton key={action.label} {...action} />
            ))}
        </div>
    );
}

interface NavigationRailProps {
    onConnectionsClick?: MouseEventHandler<HTMLButtonElement>;
    onDocumentationClick?: MouseEventHandler<HTMLButtonElement>;
    onSettingsClick?: MouseEventHandler<HTMLButtonElement>;
}

export function NavigationRail({
    onConnectionsClick,
    onDocumentationClick,
    onSettingsClick,
}: NavigationRailProps) {
    const connectionActions: RailAction[] = onConnectionsClick
        ? topActions.map((action) => ({
              ...action,
              onClick: onConnectionsClick,
          }))
        : topActions;
    const utilityActions = createBottomRailActions({
        onDocumentationClick,
        onSettingsClick,
    });

    return (
        <aside className="flex w-14 shrink-0 flex-col justify-between border-r bg-sidebar text-sidebar-foreground">
            <div>
                <RailGroup actions={connectionActions} />
            </div>

            <div className="mx-3 border-t border-sidebar-border">
                <RailGroup actions={utilityActions} />
            </div>
        </aside>
    );
}
