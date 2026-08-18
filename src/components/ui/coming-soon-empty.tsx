import { Construction } from "lucide-react";

import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

export type ComingSoonEmptyProps = {
    className?: string;
    /** 主标题，默认：该功能正在开发中 */
    title?: string;
    /** 副文案，可选 */
    description?: string;
};

/**
 * 通用「功能开发中」占位，基于 Empty，可在表单、设置页等复用。
 */
export function ComingSoonEmpty({
    className,
    title = "该功能正在开发中",
    description,
}: ComingSoonEmptyProps) {
    return (
        <Empty
            className={cn(
                "min-h-[200px] border border-dashed bg-muted/20 py-8",
                className,
            )}
        >
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Construction />
                </EmptyMedia>
                <EmptyTitle>{title}</EmptyTitle>
                {description ? (
                    <EmptyDescription>{description}</EmptyDescription>
                ) : null}
            </EmptyHeader>
        </Empty>
    );
}
