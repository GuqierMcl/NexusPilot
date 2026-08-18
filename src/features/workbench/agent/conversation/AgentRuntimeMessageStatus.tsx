"use client";

import { useAuiState } from "@assistant-ui/react";
import { AlertCircleIcon, BanIcon } from "lucide-react";

import { getRuntimeMessageStatusView } from "@/features/workbench/agent/state";
import { cn } from "@/lib/utils";

export function AgentRuntimeMessageStatus() {
  const metadata = useAuiState((state) => state.message.metadata);
  const status = getRuntimeMessageStatusView(metadata);

  if (!status) {
    return null;
  }

  if (status.kind === "interrupted") {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
        <BanIcon className="size-3" />
        <span>{status.label}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2",
        "text-xs text-destructive dark:bg-destructive/5 dark:text-red-200",
      )}
    >
      <div className="flex items-center gap-1.5 font-medium">
        <AlertCircleIcon className="size-3.5" />
        <span>{status.label}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[11px] opacity-90">
        {status.description}
      </div>
    </div>
  );
}
