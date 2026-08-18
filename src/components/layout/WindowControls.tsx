import type { ReactNode } from "react";
import { Copy, Minus, Plus, Square, X } from "lucide-react";

import { cn } from "@/lib/utils";

type WindowControlsProps = {
    platform: "macos" | "windows" | "linux";
    isMaximized: boolean;
    onMinimize: () => void | Promise<void>;
    onToggleMaximize: () => void | Promise<void>;
    onClose: () => void | Promise<void>;
    className?: string;
};

type ControlButtonProps = {
    label: string;
    onClick: () => void | Promise<void>;
    className?: string;
    children: ReactNode;
};

function ControlButton({
    label,
    onClick,
    className,
    children,
}: ControlButtonProps) {
    return (
        <button
            type="button"
            data-no-drag="true"
            aria-label={label}
            title={label}
            onClick={() => {
                void onClick();
            }}
            className={className}
        >
            {children}
        </button>
    );
}

function WindowsControls({
    isMaximized,
    onMinimize,
    onToggleMaximize,
    onClose,
    className,
}: Omit<WindowControlsProps, "platform">) {
    return (
        <div
            data-no-drag="true"
            className={cn("flex h-full items-stretch", className)}
        >
            <ControlButton
                label="最小化窗口"
                onClick={onMinimize}
                className="flex h-full w-10 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
                <Minus className="size-3.5" />
            </ControlButton>

            <ControlButton
                label={isMaximized ? "还原窗口" : "最大化窗口"}
                onClick={onToggleMaximize}
                className="flex h-full w-10 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
                {isMaximized ? (
                    <Copy className="size-3.5" />
                ) : (
                    <Square className="size-3.5" />
                )}
            </ControlButton>

            <ControlButton
                label="关闭窗口"
                onClick={onClose}
                className="flex h-full w-10 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
                <X className="size-3.5" />
            </ControlButton>
        </div>
    );
}

function MacControls({
    isMaximized,
    onMinimize,
    onToggleMaximize,
    onClose,
    className,
}: Omit<WindowControlsProps, "platform">) {
    return (
        <div
            data-no-drag="true"
            className={cn("group flex items-center gap-2 px-3", className)}
        >
            <ControlButton
                label="关闭窗口"
                onClick={onClose}
                className="flex size-3 items-center justify-center rounded-full bg-[#ff5f57] text-black/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] transition-transform duration-150 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
                <X className="size-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 motion-reduce:transition-none" />
            </ControlButton>

            <ControlButton
                label="最小化窗口"
                onClick={onMinimize}
                className="flex size-3 items-center justify-center rounded-full bg-[#ffbd2e] text-black/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] transition-transform duration-150 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
                <Minus className="size-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 motion-reduce:transition-none" />
            </ControlButton>

            <ControlButton
                label={isMaximized ? "还原窗口" : "最大化窗口"}
                onClick={onToggleMaximize}
                className="flex size-3 items-center justify-center rounded-full bg-[#28c840] text-black/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] transition-transform duration-150 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
                {isMaximized ? (
                    <Copy className="size-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 motion-reduce:transition-none" />
                ) : (
                    <Plus className="size-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 motion-reduce:transition-none" />
                )}
            </ControlButton>
        </div>
    );
}

export function WindowControls({
    platform,
    isMaximized,
    onMinimize,
    onToggleMaximize,
    onClose,
    className,
}: WindowControlsProps) {
    if (platform === "macos") {
        return (
            <MacControls
                isMaximized={isMaximized}
                onMinimize={onMinimize}
                onToggleMaximize={onToggleMaximize}
                onClose={onClose}
                className={className}
            />
        );
    }

    return (
        <WindowsControls
            isMaximized={isMaximized}
            onMinimize={onMinimize}
            onToggleMaximize={onToggleMaximize}
            onClose={onClose}
            className={className}
        />
    );
}
