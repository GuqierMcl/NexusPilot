export type ContextCompactionTrigger =
  | "auto_pre_turn"
  | "auto_mid_turn"
  | "manual"
  | "provider_overflow"
  | "model_switch";

export interface RuntimeContextUsageView {
  contextWindow: number;
  estimatedInputTokens: number;
  providerInputTokens?: number;
  reservedOutputTokens: number;
  activeTokens: number;
  source: "estimate" | "provider";
  view: "raw" | "checkpoint";
  checkpointId?: string;
  forecastReason?: string;
}

export type RuntimeContextUsageState =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; value: RuntimeContextUsageView };

export interface RuntimeCompactionMarkerView {
  trigger: ContextCompactionTrigger;
  createdAt: number;
  coverageThroughRunId?: string;
  beforeTokens: number;
  afterTokens?: number;
  status: "preparing" | "created" | "failed" | "recovered";
}

export interface RuntimeCompactionActivityView {
  id: string;
  runId: string;
  requestIndex: number;
  boundaryStepIndex?: number;
  attemptIndex: number;
  trigger: ContextCompactionTrigger;
  status: "preparing" | "created" | "failed" | "recovered" | "interrupted";
  checkpointId?: string;
  beforeEstimatedInputTokens: number;
  afterEstimatedInputTokens?: number;
  startedAt: number;
  completedAt?: number;
}

export interface ContextDisplayUsageView {
  totalTokens: number;
  modelContextWindow: number;
  percent: number | null;
  source: "estimate" | "provider" | "legacy" | "invalid";
  view: "raw" | "checkpoint" | "legacy" | "unknown";
  providerInputTokens?: number;
  reservedOutputTokens?: number;
  isLegacy: boolean;
}

interface AssistantMessageMetadataSource {
  role?: unknown;
  metadata?: unknown;
}

export function getLatestAssistantMessageMetadata(
  messages: readonly AssistantMessageMetadataSource[],
): unknown {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message.metadata;
    }
  }
  return undefined;
}

export function getRuntimeContextUsageView(
  metadata: unknown,
): RuntimeContextUsageView | null {
  const state = getRuntimeContextUsageState(metadata);
  return state.kind === "valid" ? state.value : null;
}

export function getRuntimeContextUsageState(
  metadata: unknown,
): RuntimeContextUsageState {
  const nexus = readNexus(metadata);
  if (!nexus || !Object.prototype.hasOwnProperty.call(nexus, "contextUsage")) {
    return { kind: "absent" };
  }
  const record = readRecord(nexus.contextUsage);
  if (!record) return { kind: "invalid" };

  const contextWindow = isNonNegativeFinite(record.contextWindow)
    ? record.contextWindow
    : 0;
  const estimatedInputTokens = record.estimatedInputTokens;
  const reservedOutputTokens = record.reservedOutputTokens;
  if (
    !isNonNegativeFinite(estimatedInputTokens)
    || !isNonNegativeFinite(reservedOutputTokens)
    || (record.view !== "raw" && record.view !== "checkpoint")
    || (record.view === "raw" && record.checkpointId !== undefined)
    || (record.view === "checkpoint"
      && (typeof record.checkpointId !== "string" || record.checkpointId.length === 0))
  ) {
    return { kind: "invalid" };
  }

  const providerInputTokens = isNonNegativeFinite(record.providerInputTokens)
    ? record.providerInputTokens
    : undefined;
  return {
    kind: "valid",
    value: {
      contextWindow,
      estimatedInputTokens,
      ...(providerInputTokens === undefined ? {} : { providerInputTokens }),
      reservedOutputTokens,
      activeTokens: estimatedInputTokens,
      source: "estimate",
      view: record.view,
      ...(typeof record.checkpointId === "string" && record.checkpointId.length > 0
        ? { checkpointId: record.checkpointId }
        : {}),
      ...(typeof record.forecastReason === "string"
        ? { forecastReason: record.forecastReason }
        : {}),
    },
  };
}

export function getRuntimeCompactionMarkerView(
  metadata: unknown,
): RuntimeCompactionMarkerView | null {
  const marker = readRecord(readNexus(metadata)?.compaction);
  if (
    !marker
    || !isContextCompactionTrigger(marker.trigger)
    || !isNonNegativeFinite(marker.createdAt)
    || !isNonNegativeFinite(marker.beforeTokens)
    || !isContextCompactionStatus(marker.status)
    || ((marker.status === "created" || marker.status === "recovered")
      && (typeof marker.coverageThroughRunId !== "string"
        || marker.coverageThroughRunId.length === 0
        || !isNonNegativeFinite(marker.afterTokens)))
  ) {
    return null;
  }
  return {
    trigger: marker.trigger,
    createdAt: marker.createdAt,
    ...(typeof marker.coverageThroughRunId === "string"
      ? { coverageThroughRunId: marker.coverageThroughRunId }
      : {}),
    beforeTokens: marker.beforeTokens,
    ...(isNonNegativeFinite(marker.afterTokens) ? { afterTokens: marker.afterTokens } : {}),
    status: marker.status,
  };
}

export function getRuntimeCompactionMarkerLabel(metadata: unknown): string | null {
  const marker = getRuntimeCompactionMarkerView(metadata);
  if (!marker) return null;
  if (marker.status === "preparing") return "正在压缩较早上下文";
  if (marker.status === "failed") return "上下文压缩失败";
  if (marker.status === "recovered" || marker.trigger === "provider_overflow") {
    return "上下文超限后已压缩并重试";
  }
  return marker.trigger === "manual"
    ? "已手动压缩较早上下文"
    : "已自动压缩较早上下文";
}

export function getRuntimeCompactionActivityView(
  data: unknown,
): RuntimeCompactionActivityView | null {
  const activity = readRecord(data);
  if (
    !activity
    || typeof activity.id !== "string"
    || !activity.id.startsWith("cmp_")
    || typeof activity.runId !== "string"
    || !activity.runId.startsWith("run_")
    || !isNonNegativeInteger(activity.requestIndex)
    || !isNonNegativeInteger(activity.attemptIndex)
    || !isContextCompactionTrigger(activity.trigger)
    || !isContextCompactionActivityStatus(activity.status)
    || !isNonNegativeFinite(activity.beforeEstimatedInputTokens)
    || !isNonNegativeFinite(activity.startedAt)
    || (activity.status === "preparing" && activity.completedAt !== undefined)
    || (activity.status !== "preparing" && !isNonNegativeFinite(activity.completedAt))
    || ((activity.status === "failed" || activity.status === "interrupted")
      && (activity.checkpointId !== undefined
        || activity.afterEstimatedInputTokens !== undefined))
  ) {
    return null;
  }

  return {
    id: activity.id,
    runId: activity.runId,
    requestIndex: activity.requestIndex,
    ...(isNonNegativeInteger(activity.boundaryStepIndex)
      ? { boundaryStepIndex: activity.boundaryStepIndex }
      : {}),
    attemptIndex: activity.attemptIndex,
    trigger: activity.trigger,
    status: activity.status,
    ...(typeof activity.checkpointId === "string" && activity.checkpointId.startsWith("ckpt_")
      ? { checkpointId: activity.checkpointId }
      : {}),
    beforeEstimatedInputTokens: activity.beforeEstimatedInputTokens,
    ...(isNonNegativeFinite(activity.afterEstimatedInputTokens)
      ? { afterEstimatedInputTokens: activity.afterEstimatedInputTokens }
      : {}),
    startedAt: activity.startedAt,
    ...(isNonNegativeFinite(activity.completedAt) ? { completedAt: activity.completedAt } : {}),
  };
}

export function getRuntimeCompactionActivityLabel(
  activity: Pick<RuntimeCompactionActivityView, "status">,
): string {
  switch (activity.status) {
    case "preparing":
      return "正在压缩上下文…";
    case "created":
    case "recovered":
      return "上下文已压缩";
    case "failed":
      return "上下文压缩失败";
    case "interrupted":
      return "上下文压缩已中止";
  }
}

function isContextCompactionStatus(
  value: unknown,
): value is RuntimeCompactionMarkerView["status"] {
  return value === "preparing"
    || value === "created"
    || value === "failed"
    || value === "recovered";
}

export function getContextDisplayUsage(input: {
  runtimeUsage: RuntimeContextUsageView | null;
  runtimeUsageInvalid?: boolean;
  legacyTotalTokens: number;
  legacyContextWindow: number;
}): ContextDisplayUsageView {
  if (input.runtimeUsageInvalid) {
    return {
      totalTokens: 0,
      modelContextWindow: 0,
      percent: null,
      source: "invalid",
      view: "unknown",
      isLegacy: false,
    };
  }
  if (input.runtimeUsage) {
    const usableWindow = isPositiveFinite(input.runtimeUsage.contextWindow)
      ? input.runtimeUsage.contextWindow
      : 0;
    return {
      totalTokens: input.runtimeUsage.activeTokens,
      modelContextWindow: usableWindow,
      percent: usableWindow > 0
        ? Math.min((input.runtimeUsage.activeTokens / usableWindow) * 100, 100)
        : null,
      source: input.runtimeUsage.source,
      view: input.runtimeUsage.view,
      ...(input.runtimeUsage.providerInputTokens === undefined
        ? {}
        : { providerInputTokens: input.runtimeUsage.providerInputTokens }),
      reservedOutputTokens: input.runtimeUsage.reservedOutputTokens,
      isLegacy: false,
    };
  }

  const modelContextWindow = isPositiveFinite(input.legacyContextWindow)
    ? input.legacyContextWindow
    : 0;
  const totalTokens = isNonNegativeFinite(input.legacyTotalTokens)
    ? input.legacyTotalTokens
    : 0;
  return {
    totalTokens,
    modelContextWindow,
    percent: modelContextWindow > 0
      ? Math.min((totalTokens / modelContextWindow) * 100, 100)
      : null,
    source: "legacy",
    view: "legacy",
    isLegacy: true,
  };
}

function readNexus(metadata: unknown): Record<string, unknown> | null {
  const custom = readRecord(readRecord(metadata)?.custom);
  return readRecord(custom?.nexus);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFinite(value) && Number.isInteger(value);
}

function isPositiveFinite(value: unknown): value is number {
  return isNonNegativeFinite(value) && value > 0;
}

function isContextCompactionTrigger(value: unknown): value is ContextCompactionTrigger {
  return value === "auto_pre_turn"
    || value === "auto_mid_turn"
    || value === "manual"
    || value === "provider_overflow"
    || value === "model_switch";
}

function isContextCompactionActivityStatus(
  value: unknown,
): value is RuntimeCompactionActivityView["status"] {
  return value === "preparing"
    || value === "created"
    || value === "failed"
    || value === "recovered"
    || value === "interrupted";
}
