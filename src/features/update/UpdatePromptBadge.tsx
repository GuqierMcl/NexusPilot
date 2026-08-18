import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useUpdateStore } from "@/store/slices/update-slice";

interface UpdatePromptBadgeProps {
    className?: string;
}

export function UpdatePromptBadge({ className }: UpdatePromptBadgeProps) {
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
        <Badge
            variant="outline"
            className={cn(
                "cursor-pointer border-amber-500/30 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-300",
                className,
            )}
            render={
                <button
                    type="button"
                    title={`发现新版本 ${availableUpdateInfo.version}`}
                    aria-label={`发现新版本 ${availableUpdateInfo.version}`}
                    onClick={() => setUpdateDialogOpen(true)}
                >
                    有新版本
                </button>
            }
        />
    );
}
