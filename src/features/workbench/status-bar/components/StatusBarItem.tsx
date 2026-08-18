import type { FC } from "react";

import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type {
    WorkbenchStatusItemModel,
    WorkbenchStatusItemTone,
    WorkbenchStatusItemWidth,
} from "../types";

interface StatusBarItemProps
    extends Pick<
        WorkbenchStatusItemModel,
        | "label"
        | "icon"
        | "iconClassName"
        | "title"
        | "tooltipContent"
        | "tone"
        | "width"
        | "onClick"
        | "onMouseEnter"
        | "onMouseLeave"
    > {}

function getToneClassName(tone: WorkbenchStatusItemTone) {
    switch (tone) {
        case "muted":
            return "text-muted-foreground";
        case "error":
            return "text-destructive";
        case "warning":
            return "text-amber-600 dark:text-amber-400";
        case "success":
            return "text-emerald-600 dark:text-emerald-400";
        case "info":
            return "text-sky-600 dark:text-sky-300";
        case "default":
        default:
            return "text-foreground";
    }
}

function getWidthClassName(width: WorkbenchStatusItemWidth) {
    switch (width) {
        case "compact":
            return "shrink-0";
        case "elastic":
            return "min-w-0 flex-1";
        case "content":
        default:
            return "min-w-0 shrink";
    }
}

export const StatusBarItem: FC<StatusBarItemProps> = ({
    label,
    icon: Icon,
    iconClassName,
    title,
    tooltipContent,
    tone = "default",
    width = "content",
    onClick,
    onMouseEnter,
    onMouseLeave,
}) => {
    const isInteractive = Boolean(onClick);
    const hasRichTooltip = tooltipContent != null;
    const className = cn(
        "inline-flex h-full items-center gap-1 truncate rounded-sm px-1.5",
        "border-0 bg-transparent text-xs leading-none transition-colors",
        "hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground",
        getWidthClassName(width),
        isInteractive ? "cursor-pointer" : "cursor-default",
        getToneClassName(tone),
    );

    const content = (
        <>
            {Icon ? (
                <span className="flex shrink-0 items-center">
                    <Icon className={cn("size-3", iconClassName)} />
                </span>
            ) : null}
            <span className="min-w-0 truncate">{label}</span>
        </>
    );

    const triggerProps = {
        "aria-label": title ?? label,
        onMouseEnter,
        onMouseLeave,
        className,
    };

    const trigger = onClick ? (
        <TooltipTrigger
            render={
                <button type="button" onClick={onClick} {...triggerProps}>
                    {content}
                </button>
            }
        />
    ) : (
        <TooltipTrigger render={<div {...triggerProps}>{content}</div>} />
    );

    return (
        <Tooltip>
            {trigger}
            <TooltipContent
                side="top"
                className={hasRichTooltip ? "max-w-md items-start" : undefined}
            >
                {tooltipContent ?? title ?? label}
            </TooltipContent>
        </Tooltip>
    );
};
