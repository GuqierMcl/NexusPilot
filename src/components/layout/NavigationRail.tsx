import type { ComponentType, MouseEventHandler } from "react";
import {
    Boxes,
    Settings,
} from "lucide-react";

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

const bottomActions: RailAction[] = [{ label: "设置", icon: Settings }];

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
    onSettingsClick?: MouseEventHandler<HTMLButtonElement>;
}

export function NavigationRail({
    onConnectionsClick,
    onSettingsClick,
}: NavigationRailProps) {
    const connectionActions: RailAction[] = onConnectionsClick
        ? topActions.map((action) => ({
              ...action,
              onClick: onConnectionsClick,
          }))
        : topActions;
    const settingsActions: RailAction[] = onSettingsClick
        ? bottomActions.map((action) => ({
              ...action,
              onClick: onSettingsClick,
          }))
        : bottomActions;

    return (
        <aside className="flex w-14 shrink-0 flex-col justify-between border-r bg-sidebar text-sidebar-foreground">
            <div>
                <RailGroup actions={connectionActions} />
            </div>

            <div className="mx-3 border-t border-sidebar-border">
                <RailGroup actions={settingsActions} />
            </div>
        </aside>
    );
}
