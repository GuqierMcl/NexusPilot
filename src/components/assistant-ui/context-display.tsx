"use client";

import { useAuiState } from "@assistant-ui/react";
import { useThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import type { ThreadTokenUsage } from "@assistant-ui/react-ai-sdk";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  getContextDisplayUsage,
  type RuntimeContextUsageView,
} from "@/features/workbench/agent/state/runtime-context-view";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FC,
  type ReactNode,
} from "react";

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000)
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${tokens}`;
};

export const formatContextUsagePercent = (percent: number | null): string => {
  if (percent === null) return "—";
  if (percent > 0 && percent < 1) {
    return "<1%";
  }

  return `${Math.round(percent)}%`;
};

type UsageSeverity = "normal" | "warning" | "critical";

const getUsageSeverity = (percent: number): UsageSeverity => {
  if (percent > 85) return "critical";
  if (percent >= 65) return "warning";
  return "normal";
};

const getStrokeColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "stroke-red-500";
  if (severity === "warning") return "stroke-amber-500";
  return "stroke-foreground";
};

const getBarColor = (percent: number): string => {
  const severity = getUsageSeverity(percent);
  if (severity === "critical") return "bg-red-500";
  if (severity === "warning") return "bg-amber-500";
  return "bg-foreground";
};

type ContextDisplayContextValue = {
  usage: ThreadTokenUsage | undefined;
  totalTokens: number;
  percent: number | null;
  modelContextWindow: number;
  source: "estimate" | "provider" | "legacy" | "invalid";
  view: "raw" | "checkpoint" | "legacy" | "unknown";
  reservedOutputTokens?: number;
  isLegacy: boolean;
};

const ContextDisplayContext = createContext<ContextDisplayContextValue | null>(
  null,
);

function useContextDisplay(): ContextDisplayContextValue {
  const ctx = useContext(ContextDisplayContext);
  if (!ctx) {
    throw new Error("ContextDisplay.* must be used within ContextDisplay.Root");
  }
  return ctx;
}

type PresetProps = {
  modelContextWindow: number;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  usage?: ThreadTokenUsage | undefined;
  runtimeUsage?: RuntimeContextUsageView | null;
  runtimeUsageInvalid?: boolean;
};

type ContextDisplayRootProps = {
  modelContextWindow: number;
  children: ReactNode;
  usage?: ThreadTokenUsage | undefined;
  runtimeUsage?: RuntimeContextUsageView | null;
  runtimeUsageInvalid?: boolean;
};

export interface ContextDisplayLegacyTokenState {
  threadId: string;
  totalTokens: number;
  usage: ThreadTokenUsage | undefined;
}

export function ContextDisplayRootView({
  currentThreadId,
  modelContextWindow,
  children,
  usage,
  persistedTokenState,
  runtimeUsage = null,
  runtimeUsageInvalid = false,
}: {
  currentThreadId: string;
  modelContextWindow: number;
  children: ReactNode;
  usage: ThreadTokenUsage | undefined;
  persistedTokenState: ContextDisplayLegacyTokenState;
  runtimeUsage?: RuntimeContextUsageView | null;
  runtimeUsageInvalid?: boolean;
}) {
  const rawTokens = usage?.totalTokens ?? 0;
  const effectiveTokenState = persistedTokenState.threadId === currentThreadId
    ? persistedTokenState
    : {
        threadId: currentThreadId,
        totalTokens: rawTokens > 0 ? rawTokens : 0,
        usage,
      };
  const displayUsage = getContextDisplayUsage({
    runtimeUsage,
    runtimeUsageInvalid,
    legacyTotalTokens: effectiveTokenState.totalTokens,
    legacyContextWindow: modelContextWindow,
  });
  const contextValue: ContextDisplayContextValue = {
    usage: effectiveTokenState.usage,
    totalTokens: displayUsage.totalTokens,
    percent: displayUsage.percent,
    modelContextWindow: displayUsage.modelContextWindow,
    source: displayUsage.source,
    view: displayUsage.view,
    reservedOutputTokens: displayUsage.reservedOutputTokens,
    isLegacy: displayUsage.isLegacy,
  };

  return (
    <ContextDisplayContext.Provider value={contextValue}>
      <Tooltip>{children}</Tooltip>
    </ContextDisplayContext.Provider>
  );
}

function ContextDisplayRootBase({
  modelContextWindow,
  children,
  usage,
  runtimeUsage = null,
  runtimeUsageInvalid = false,
}: {
  modelContextWindow: number;
  children: ReactNode;
  usage: ThreadTokenUsage | undefined;
  runtimeUsage?: RuntimeContextUsageView | null;
  runtimeUsageInvalid?: boolean;
}) {
  const threadId = useAuiState((s) => s.threadListItem.id);
  const rawTokens = usage?.totalTokens ?? 0;
  const [tokenState, setTokenState] = useState({
    threadId,
    totalTokens: rawTokens > 0 ? rawTokens : 0,
    usage,
  });

  useEffect(() => {
    setTokenState((prev) => {
      if (prev.threadId !== threadId) {
        return {
          threadId,
          totalTokens: rawTokens > 0 ? rawTokens : 0,
          usage,
        };
      }
      if (rawTokens > 0 && rawTokens !== prev.totalTokens) {
        return { ...prev, totalTokens: rawTokens, usage };
      }
      if (usage !== prev.usage) {
        return { ...prev, usage };
      }
      return prev;
    });
  }, [threadId, rawTokens, usage]);

  return (
    <ContextDisplayRootView
      currentThreadId={threadId}
      modelContextWindow={modelContextWindow}
      usage={usage}
      persistedTokenState={tokenState}
      runtimeUsage={runtimeUsage}
      runtimeUsageInvalid={runtimeUsageInvalid}
    >
      {children}
    </ContextDisplayRootView>
  );
}

function ContextDisplayRootInternal({
  modelContextWindow,
  children,
  runtimeUsage,
  runtimeUsageInvalid,
}: {
  modelContextWindow: number;
  children: ReactNode;
  runtimeUsage?: RuntimeContextUsageView | null;
  runtimeUsageInvalid?: boolean;
}) {
  const usage = useThreadTokenUsage();
  return (
    <ContextDisplayRootBase
      modelContextWindow={modelContextWindow}
      usage={usage}
      runtimeUsage={runtimeUsage}
      runtimeUsageInvalid={runtimeUsageInvalid}
    >
      {children}
    </ContextDisplayRootBase>
  );
}

function ContextDisplayRoot(props: ContextDisplayRootProps) {
  if (props.usage !== undefined) {
    return (
      <ContextDisplayRootBase
        modelContextWindow={props.modelContextWindow}
        usage={props.usage}
        runtimeUsage={props.runtimeUsage}
        runtimeUsageInvalid={props.runtimeUsageInvalid}
      >
        {props.children}
      </ContextDisplayRootBase>
    );
  }
  return (
    <ContextDisplayRootInternal
      modelContextWindow={props.modelContextWindow}
      runtimeUsage={props.runtimeUsage}
      runtimeUsageInvalid={props.runtimeUsageInvalid}
    >
      {props.children}
    </ContextDisplayRootInternal>
  );
}

function ContextDisplayTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <TooltipTrigger
      render={
        <button
        type="button"
        data-slot="context-display-trigger"
        className={cn(
          "inline-flex items-center rounded-md transition-colors",
          className,
        )}
        {...props}
      >
        {children}
      </button>
      }
    />
  );
}

type ContextSegment = {
  label: string;
  tokens: number;
};

const getContextSegments = (
  usage: ThreadTokenUsage | undefined,
): ContextSegment[] => {
  if (!usage) return [];
  return [
    { label: "输入", tokens: usage.inputTokens ?? 0 },
    { label: "缓存输入", tokens: usage.cachedInputTokens ?? 0 },
    { label: "输出", tokens: usage.outputTokens ?? 0 },
    { label: "推理", tokens: usage.reasoningTokens ?? 0 },
  ].filter((segment) => segment.tokens > 0);
};

function ContextDisplayContent({
  side = "top",
  className,
}: {
  side?: "top" | "bottom" | "left" | "right" | undefined;
  className?: string;
}) {
  const {
    usage,
    totalTokens,
    percent,
    modelContextWindow,
    source,
    view,
    reservedOutputTokens,
    isLegacy,
  } =
    useContextDisplay();

  return (
    <TooltipContent
      side={side}
      sideOffset={8}
      hideArrow
      data-slot="context-display-popover"
      className={cn(
        "bg-popover text-popover-foreground w-56 rounded-lg border p-3 text-left shadow-md",
        className,
      )}
    >
      <ContextDisplayContentView
        usage={usage}
        totalTokens={totalTokens}
        percent={percent}
        modelContextWindow={modelContextWindow}
        source={source}
        view={view}
        reservedOutputTokens={reservedOutputTokens}
        isLegacy={isLegacy}
      />
    </TooltipContent>
  );
}

export function ContextDisplayContentView({
  usage,
  totalTokens,
  percent,
  modelContextWindow,
  source,
  view,
  reservedOutputTokens,
  isLegacy,
}: ContextDisplayContextValue) {
  const segments = isLegacy ? getContextSegments(usage) : [];

  return (
    <div className="text-xs">
        <div className="flex items-baseline justify-between gap-6 whitespace-nowrap">
          <span className="font-medium">上下文用量</span>
          <span className="text-muted-foreground tabular-nums">
            {modelContextWindow > 0
              ? <>{formatTokenCount(totalTokens)} / {formatTokenCount(modelContextWindow)}</>
              : "窗口未知"}
          </span>
        </div>
        <div className="bg-muted mt-2.5 h-1 overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full w-(--usage-width) rounded-full transition-[width] duration-300",
              totalTokens > 0 && "min-w-1",
              getBarColor(percent ?? 0),
            )}
            style={{ "--usage-width": `${percent ?? 0}%` } as React.CSSProperties}
          />
        </div>
        {segments.length > 0 && (
          <div className="mt-3 grid gap-1.5">
            {segments.map((segment) => (
              <div
                key={segment.label}
                className="flex items-baseline justify-between gap-6"
              >
                <span className="text-muted-foreground">{segment.label}</span>
                <span className="tabular-nums">
                  {formatTokenCount(segment.tokens)}
                </span>
              </div>
            ))}
          </div>
        )}
        {!isLegacy && (
          <div className="mt-3 grid gap-1.5 border-t pt-2 text-muted-foreground">
            <div className="flex items-baseline justify-between gap-6">
              <span>活动输入</span>
              <span className="tabular-nums">
                {formatTokenCount(Math.max(totalTokens - (reservedOutputTokens ?? 0), 0))}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-6">
              <span>输入来源</span>
              <span>
                {source === "provider"
                  ? "Provider 观测"
                  : source === "estimate" ? "估算" : "未知"}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-6">
              <span>上下文视图</span>
              <span>
                {view === "checkpoint"
                  ? "检查点"
                  : view === "raw" ? "原始上下文" : "未知"}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-6">
              <span>预留输出</span>
              <span className="tabular-nums">{formatTokenCount(reservedOutputTokens ?? 0)}</span>
            </div>
          </div>
        )}
    </div>
  );
}

const RING_SIZE = 18;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function RingVisual() {
  const { percent } = useContextDisplay();

  return (
    <svg
      aria-hidden="true"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className="-rotate-90"
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        className="stroke-muted"
      />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={
          RING_CIRCUMFERENCE - ((percent ?? 0) / 100) * RING_CIRCUMFERENCE
        }
        className={cn(
          "transition-[stroke-dashoffset,stroke] duration-300",
          getStrokeColor(percent ?? 0),
        )}
      />
    </svg>
  );
}

function RingPercentLabel() {
  const { percent } = useContextDisplay();
  return (
    <span className="font-mono tabular-nums">
      {formatContextUsagePercent(percent)}
    </span>
  );
}

export function ContextDisplayRingBody({
  className,
  side,
}: Pick<PresetProps, "className" | "side">) {
  const {
    percent,
    modelContextWindow,
    source,
    view,
    reservedOutputTokens,
    isLegacy,
  } = useContextDisplay();
  const usageLabel = modelContextWindow > 0
    ? formatContextUsagePercent(percent)
    : "窗口未知";
  const sourceLabel = source === "provider"
    ? "Provider 观测"
    : source === "estimate" ? "估算" : "未知";
  const viewLabel = view === "checkpoint"
    ? "检查点"
    : view === "raw" ? "原始上下文" : "未知";
  const ariaLabel = isLegacy
    ? `上下文用量：${usageLabel}`
    : `上下文用量：${usageLabel}；输入来源：${sourceLabel}；上下文视图：${viewLabel}；预留输出：${formatTokenCount(reservedOutputTokens ?? 0)}`;

  return (
    <>
      <ContextDisplayTrigger
        className={cn(
          "text-muted-foreground hover:text-foreground gap-1.5 px-1.5 py-1 text-xs",
          className,
        )}
        aria-label={ariaLabel}
      >
        <RingVisual />
        <RingPercentLabel />
      </ContextDisplayTrigger>
      <ContextDisplayContent side={side} />
    </>
  );
}

const ContextDisplayRing: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side,
  usage,
  runtimeUsage,
  runtimeUsageInvalid,
}) => (
  <ContextDisplayRoot modelContextWindow={modelContextWindow} usage={usage} runtimeUsage={runtimeUsage} runtimeUsageInvalid={runtimeUsageInvalid}>
    <ContextDisplayRingBody className={className} side={side} />
  </ContextDisplayRoot>
);

function BarVisual() {
  const { percent, totalTokens } = useContextDisplay();

  return (
    <div className="flex items-center gap-2">
      <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-300",
            getBarColor(percent ?? 0),
          )}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
      <span className="text-muted-foreground text-[10px] tabular-nums">
        {formatTokenCount(totalTokens)} ({percent === null ? "—" : `${Math.round(percent)}%`})
      </span>
    </div>
  );
}

const ContextDisplayBar: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side,
  usage,
  runtimeUsage,
  runtimeUsageInvalid,
}) => (
  <ContextDisplayRoot modelContextWindow={modelContextWindow} usage={usage} runtimeUsage={runtimeUsage} runtimeUsageInvalid={runtimeUsageInvalid}>
    <ContextDisplayTrigger
      className={cn("px-2 py-1", className)}
      aria-label="上下文用量"
    >
      <BarVisual />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

function TextVisual() {
  const { totalTokens, modelContextWindow } = useContextDisplay();

  return (
    <>
      {formatTokenCount(totalTokens)} / {formatTokenCount(modelContextWindow)}
    </>
  );
}

const ContextDisplayText: FC<PresetProps> = ({
  modelContextWindow,
  className,
  side,
  usage,
  runtimeUsage,
  runtimeUsageInvalid,
}) => (
  <ContextDisplayRoot modelContextWindow={modelContextWindow} usage={usage} runtimeUsage={runtimeUsage} runtimeUsageInvalid={runtimeUsageInvalid}>
    <ContextDisplayTrigger
      aria-label="上下文用量"
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-accent-foreground px-2 py-1 font-mono text-xs tabular-nums",
        className,
      )}
    >
      <TextVisual />
    </ContextDisplayTrigger>
    <ContextDisplayContent side={side} />
  </ContextDisplayRoot>
);

const ContextDisplay = {} as {
  Root: typeof ContextDisplayRoot;
  Trigger: typeof ContextDisplayTrigger;
  Content: typeof ContextDisplayContent;
  Ring: typeof ContextDisplayRing;
  Bar: typeof ContextDisplayBar;
  Text: typeof ContextDisplayText;
};

ContextDisplay.Root = ContextDisplayRoot;
ContextDisplay.Trigger = ContextDisplayTrigger;
ContextDisplay.Content = ContextDisplayContent;
ContextDisplay.Ring = ContextDisplayRing;
ContextDisplay.Bar = ContextDisplayBar;
ContextDisplay.Text = ContextDisplayText;

export {
  ContextDisplay,
  ContextDisplayRoot,
  ContextDisplayTrigger,
  ContextDisplayContent,
  ContextDisplayRing,
  ContextDisplayBar,
  ContextDisplayText,
};
