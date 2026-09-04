"use client";

import { useAuiState } from "@assistant-ui/react";
import { useState } from "react";
import {
  AlertCircleIcon,
  BanIcon,
  CheckIcon,
  CopyIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { getRuntimeMessageStatusView } from "@/features/workbench/agent/state";
import { cn } from "@/lib/utils";

export function AgentRuntimeMessageStatus() {
  const metadata = useAuiState((state) => state.message.metadata);
  const status = getRuntimeMessageStatusView(metadata);
  const [copied, setCopied] = useState(false);

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

  const copyDescription = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(status.description);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className={cn(
        "mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2",
        "text-xs text-destructive dark:bg-destructive/5 dark:text-red-200",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-medium">
          <AlertCircleIcon className="size-3.5" />
          <span>{status.label}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-current hover:bg-destructive/10 hover:text-current"
          aria-label="复制错误信息"
          title={copied ? "已复制" : "复制错误信息"}
          onClick={() => void copyDescription()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
      <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-[11px] opacity-90 [overflow-wrap:anywhere]">
        {status.description}
      </div>
    </div>
  );
}
