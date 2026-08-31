import { CircleArrowUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    type AvailableUpdateInfo,
    useUpdateStore,
} from "@/store/slices/update-slice";

export interface UpdatePromptProps {
    appearance?: "badge" | "icon";
    className?: string;
}

export interface UpdatePromptContentProps extends UpdatePromptProps {
    availableUpdateInfo: AvailableUpdateInfo;
    onOpen: () => void;
}

export function UpdatePromptContent({
    appearance = "badge",
    availableUpdateInfo,
    className,
    onOpen,
}: UpdatePromptContentProps) {
    const promptLabel = `发现新版本 ${availableUpdateInfo.version}`;

    if (appearance === "icon") {
        return (
            <Button
                type="button"
                variant="ghost"
                size="sm"
                data-slot="update-prompt-icon"
                data-no-drag="true"
                title={promptLabel}
                tooltipSide="bottom"
                aria-label={promptLabel}
                className={cn(
                    "group/update-prompt h-7 gap-0 overflow-hidden px-1.5 text-amber-600 transition-[gap,padding,background-color,color,border-color] duration-200 hover:gap-1.5 hover:bg-amber-500/10 hover:pr-2.5 hover:text-amber-700 focus-visible:gap-1.5 focus-visible:pr-2.5 dark:text-amber-300 dark:hover:bg-amber-500/15 dark:hover:text-amber-200 motion-reduce:transition-none",
                    className,
                )}
                onClick={onOpen}
            >
                <CircleArrowUp className="size-4" />
                <span
                    aria-hidden="true"
                    className="inline-block max-w-0 overflow-hidden opacity-0 transition-[max-width,opacity] duration-200 group-hover/update-prompt:max-w-16 group-hover/update-prompt:opacity-100 group-focus-visible/update-prompt:max-w-16 group-focus-visible/update-prompt:opacity-100 motion-reduce:transition-none"
                >
                    新版本
                </span>
            </Button>
        );
    }

    return (
        <Badge
            variant="outline"
            className={cn(
                "cursor-pointer border-amber-500/30 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-300",
                className,
            )}
            render={
                <button
                    type="button"
                    title={promptLabel}
                    aria-label={promptLabel}
                    onClick={onOpen}
                >
                    有新版本
                </button>
            }
        />
    );
}

export function UpdatePrompt(props: UpdatePromptProps) {
    const availableUpdateInfo = useUpdateStore(
        (state) => state.availableUpdateInfo,
    );
    const setUpdateDialogOpen = useUpdateStore(
        (state) => state.setUpdateDialogOpen,
    );

    if (!availableUpdateInfo) {
        return null;
    }

    return (
        <UpdatePromptContent
            {...props}
            availableUpdateInfo={availableUpdateInfo}
            onOpen={() => setUpdateDialogOpen(true)}
        />
    );
}
