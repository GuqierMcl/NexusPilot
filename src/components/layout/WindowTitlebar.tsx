import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";

import { WindowControls } from "./WindowControls";
import { useWindowChrome } from "./useWindowChrome";

type WindowTitlebarProps = {
    children: ReactNode;
    actions?: ReactNode;
    center?: ReactNode;
    macosContent?: ReactNode;
    className?: string;
    contentClassName?: string;
};

export function WindowTitlebar({
    children,
    actions,
    center,
    macosContent,
    className,
    contentClassName,
}: WindowTitlebarProps) {
    const {
        platform,
        controlsSide,
        isMaximized,
        minimize,
        toggleMaximize,
        close,
    } = useWindowChrome();

    const controls = (
        <WindowControls
            platform={platform}
            isMaximized={isMaximized}
            onMinimize={minimize}
            onToggleMaximize={toggleMaximize}
            onClose={close}
        />
    );

    const handleDoubleClick = () => {
        if (platform === "macos") {
            return;
        }

        void toggleMaximize();
    };

    return (
        <header
            data-platform={platform}
            data-maximized={isMaximized}
            className={cn(
                "relative grid h-10 grid-cols-[auto_minmax(0,1fr)_auto] items-center border-b bg-background/95 text-foreground backdrop-blur supports-backdrop-filter:bg-background/80",
                className,
            )}
        >
            {controlsSide === "left" ? controls : <div className="h-full" />}

            <div
                data-tauri-drag-region
                className={cn(
                    "flex h-full min-w-0 items-center justify-start px-3 select-none",
                    contentClassName,
                )}
                onDoubleClick={handleDoubleClick}
            >
                <div className="flex min-w-0 items-center justify-start">
                    {platform === "macos" && macosContent !== undefined
                        ? macosContent
                        : children}
                </div>
            </div>

            {center ? (
                <div
                    data-no-drag="true"
                    className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center"
                >
                    {center}
                </div>
            ) : null}

            <div
                data-no-drag="true"
                className="flex h-full min-w-0 items-center justify-end gap-2 pr-2"
            >
                {actions ? (
                    <div className="flex items-center gap-2">{actions}</div>
                ) : null}
                {actions != null && controlsSide === "right" ? (
                    <Separator orientation="vertical" className="my-2" />
                ) : null}
                {controlsSide === "right" ? controls : null}
            </div>
        </header>
    );
}
