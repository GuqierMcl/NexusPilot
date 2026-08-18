import { AlertCircle, CheckCircle2, CircleDashed } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { IAppError, ConnectionTestResult } from "@/types/ipc";

export type ConnectionTestState =
    | { status: "idle" }
    | { status: "testing" }
    | { status: "success"; result: ConnectionTestResult }
    | { status: "error"; error: IAppError };

export interface ConnectionTestStatusBarProps {
    state: ConnectionTestState;
}

function formatDriverName(driverName: string): string {
    if (driverName === "postgres") {
        return "PostgreSQL";
    }
    if (driverName === "mysql") {
        return "MySQL";
    }
    if (driverName === "redis") {
        return "Redis";
    }
    return driverName;
}

function TruncatedTooltip({
    children,
    className,
}: {
    children: string;
    className?: string;
}) {
    return (
        <Tooltip>
            <TooltipTrigger
                render={<span className={cn("min-w-0 truncate", className)}>{children}</span>}
            />
            <TooltipContent>
                <span className="break-all">{children}</span>
            </TooltipContent>
        </Tooltip>
    );
}

export function ConnectionTestStatusBar({ state }: ConnectionTestStatusBarProps) {
    const isSuccess = state.status === "success";
    const isError = state.status === "error";
    const successMeta = isSuccess
        ? [
            `${formatDriverName(state.result.driverName)} · ${state.result.endpoint}`,
            state.result.serverVersion
                ? `服务器版本：${state.result.serverVersion}`
                : null,
        ].filter(Boolean).join(" · ")
        : "";

    return (
        <div
            className={cn(
                "flex min-h-10 w-full min-w-0 items-center gap-2 border-t px-4 py-2 text-sm",
                state.status === "idle" && "bg-muted/40 text-muted-foreground",
                state.status === "testing" && "bg-muted/50 text-foreground",
                isSuccess && "border-green-500/20 bg-green-500/12 text-green-900",
                isError && "border-destructive/20 bg-destructive/10 text-destructive",
            )}
        >
            {state.status === "idle" && <CircleDashed className="size-4 shrink-0" />}
            {state.status === "testing" && <Spinner className="shrink-0" />}
            {isSuccess && <CheckCircle2 className="size-4 shrink-0" />}
            {isError && <AlertCircle className="size-4 shrink-0" />}

            {state.status === "idle" && (
                <span className="truncate">尚未测试连接</span>
            )}
            {state.status === "testing" && (
                <span className="truncate">正在测试连接...</span>
            )}
            {isError && (
                <TruncatedTooltip className="text-current">
                    {state.error.message}
                </TruncatedTooltip>
            )}
            {isSuccess && (
                <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    <span className="shrink-0 font-medium">连接成功</span>
                    <Badge variant="secondary">{state.result.latencyMs} ms</Badge>
                    <TruncatedTooltip className="text-muted-foreground">
                        {successMeta}
                    </TruncatedTooltip>
                </div>
            )}
        </div>
    );
}
