import {
    getConnectionTagRenderModel,
    type ConnectionTagInput,
} from "@/features/workbench/explorer/connection-tags";
import { cn } from "@/lib/utils";

type ConnectionTagBadgeProps = ConnectionTagInput;

export function ConnectionTagBadge({
    tagLabel,
    tagColor,
}: ConnectionTagBadgeProps) {
    const model = getConnectionTagRenderModel({ tagLabel, tagColor });

    if (model.kind === "none") {
        return null;
    }

    if (model.kind === "marker") {
        return (
            <span
                aria-label={`连接标签颜色：${model.color.label}`}
                className={cn(
                    "inline-flex size-2.5 shrink-0 rounded-full ring-1 ring-background/80",
                    model.color.markerClassName,
                )}
            />
        );
    }

    return (
        <span
            className={cn(
                "inline-flex h-5 max-w-20 shrink-0 items-center rounded-full px-2 text-[11px] font-medium leading-none ring-1",
                model.color.badgeClassName,
            )}
            title={model.label}
        >
            <span className="min-w-0 truncate">{model.label}</span>
        </span>
    );
}
