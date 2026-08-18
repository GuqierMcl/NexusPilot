"use client";

import {
  useEffect,
  useRef,
  useState,
  type FC,
  type PropsWithChildren,
} from "react";
import { ChevronDownIcon } from "lucide-react";

import { DotMatrix } from "@/components/dot-matrix";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface ChainOfThoughtProps extends PropsWithChildren {
  status: "running" | "complete" | "interrupted" | "failed";
  keepOpen?: boolean | undefined;
  autoOpenKey?: string | undefined;
}

export const ChainOfThought: FC<ChainOfThoughtProps> = ({
  children,
  status,
  keepOpen = false,
  autoOpenKey,
}) => {
  const running = status === "running";
  const shouldStayOpen = running || keepOpen || Boolean(autoOpenKey);
  const [open, setOpen] = useState(shouldStayOpen);
  const manuallyToggledRef = useRef(false);

  useEffect(() => {
    if (!manuallyToggledRef.current) {
      setOpen(shouldStayOpen);
    }
  }, [shouldStayOpen]);

  useEffect(() => {
    if (autoOpenKey) {
      setOpen(true);
    }
  }, [autoOpenKey]);

  const statusView = getStatusView(status);

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        manuallyToggledRef.current = true;
        setOpen(nextOpen);
      }}
      data-slot="chain-of-thought"
      data-state={status}
      className="my-1"
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <DotMatrix
          state={statusView.dotMatrixState}
          label={statusView.label}
          className="size-3.5"
        />
        <span className="grow text-left font-medium">{statusView.label}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-4 transition-transform duration-200",
            !open && "-rotate-90",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ms-1.5 flex flex-col gap-1 border-s border-border/60 ps-3 py-1">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

function getStatusView(status: ChainOfThoughtProps["status"]): {
  label: string;
  dotMatrixState: "thinking" | "success" | "stopped" | "error";
} {
  switch (status) {
    case "running":
      return { label: "正在执行", dotMatrixState: "thinking" };
    case "interrupted":
      return { label: "执行已中断", dotMatrixState: "stopped" };
    case "failed":
      return { label: "执行失败", dotMatrixState: "error" };
    case "complete":
      return { label: "执行完成", dotMatrixState: "success" };
  }
}
