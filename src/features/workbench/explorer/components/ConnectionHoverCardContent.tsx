import type { FC } from "react";

import type { ConnectionHoverCardModel } from "@/features/workbench/explorer/connection-hover-card";
import { cn } from "@/lib/utils";

export interface ConnectionHoverCardContentProps {
    model: ConnectionHoverCardModel;
}

export const ConnectionHoverCardContent: FC<ConnectionHoverCardContentProps> = ({
    model,
}) => (
    <div className="min-w-0">
        <div className="border-b px-3 py-3">
            <h3 className="break-words text-sm font-semibold leading-5 text-foreground">
                {model.name}
            </h3>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>{model.driverName}</span>
                {model.tag ? (
                    <span
                        data-slot="connection-hover-tag"
                        className="inline-flex min-w-0 items-center gap-1.5"
                    >
                        <span
                            aria-label={`连接标签颜色：${model.tag.colorLabel}`}
                            className={cn(
                                "size-2 shrink-0 rounded-full ring-1 ring-background/80",
                                model.tag.markerClassName,
                            )}
                        />
                        {model.tag.label ? (
                            <span className="min-w-0 truncate">
                                {model.tag.label}
                            </span>
                        ) : null}
                    </span>
                ) : null}
            </div>
        </div>

        <dl className="grid gap-2.5 px-3 py-3">
            {model.fields.map((field) => (
                <div
                    key={field.label}
                    className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-2 text-xs"
                >
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd className="min-w-0 break-words text-right font-mono text-foreground [overflow-wrap:anywhere]">
                        {field.value}
                    </dd>
                </div>
            ))}
        </dl>

        {model.note ? (
            <div
                data-slot="connection-hover-note"
                className="border-t px-3 py-3"
            >
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                    备注
                </div>
                <p className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground [overflow-wrap:anywhere]">
                    {model.note}
                </p>
            </div>
        ) : null}
    </div>
);
