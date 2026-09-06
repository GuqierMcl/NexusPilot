import type { ThreadDataPartProps } from "@/components/assistant-ui/thread";
import {
  getRuntimeCompactionActivityLabel,
  getRuntimeCompactionActivityView,
} from "@/features/workbench/agent/state";
import { cn } from "@/lib/utils";

const TRIGGER_LABELS = {
  auto_pre_turn: "自动 · 回复前",
  auto_mid_turn: "自动 · 执行中",
  manual: "手动",
  provider_overflow: "上下文超限恢复",
  model_switch: "模型切换",
} as const;

export function AgentContextCompactionActivity({
  name,
  data,
  dataRendererUI,
}: ThreadDataPartProps) {
  if (name !== "context-compaction") return dataRendererUI;

  const activity = getRuntimeCompactionActivityView(data);
  if (!activity) return null;

  const label = getRuntimeCompactionActivityLabel(activity);
  const detail = [
    `触发方式：${TRIGGER_LABELS[activity.trigger]}`,
    `压缩前：${activity.beforeEstimatedInputTokens.toLocaleString()} tokens`,
    ...(activity.afterEstimatedInputTokens === undefined
      ? []
      : [`压缩后：${activity.afterEstimatedInputTokens.toLocaleString()} tokens`]),
  ].join("\n");

  return (
    <div
      data-slot="agent-context-compaction-activity"
      data-compaction-id={activity.id}
      data-status={activity.status}
      className="my-3 flex w-full items-center gap-3"
      role="status"
      aria-label={label}
      title={detail}
    >
      <span className="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />
      <span
        className={cn(
          "shrink-0 text-[11px] text-muted-foreground",
          activity.status === "preparing" && "animate-pulse",
          activity.status === "failed" && "text-destructive",
        )}
      >
        {label}
      </span>
      <span className="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}
