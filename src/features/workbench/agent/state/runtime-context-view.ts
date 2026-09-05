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
}

export type RuntimeContextUsageState =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; value: RuntimeContextUsageView };

export interface RuntimeCompactionMarkerView {
  trigger: ContextCompactionTrigger;
  createdAt: number;
  coverageThroughRunId: string;
  beforeTokens: number;
  afterTokens: number;
  status: "created" | "recovered";
}

export interface ContextDisplayUsageView {
  totalTokens: number;
  modelContextWindow: number;
  percent: number | null;
  source: "estimate" | "provider" | "legacy" | "invalid";
  view: "raw" | "checkpoint" | "legacy" | "unknown";
  reservedOutputTokens?: number;
  isLegacy: boolean;
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
  const activeInputTokens = providerInputTokens ?? estimatedInputTokens;
  return {
    kind: "valid",
    value: {
      contextWindow,
      estimatedInputTokens,
      ...(providerInputTokens === undefined ? {} : { providerInputTokens }),
      reservedOutputTokens,
      activeTokens: activeInputTokens + reservedOutputTokens,
      source: providerInputTokens === undefined ? "estimate" : "provider",
      view: record.view,
      ...(typeof record.checkpointId === "string" && record.checkpointId.length > 0
        ? { checkpointId: record.checkpointId }
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
    || typeof marker.coverageThroughRunId !== "string"
    || marker.coverageThroughRunId.length === 0
    || !isNonNegativeFinite(marker.beforeTokens)
    || !isNonNegativeFinite(marker.afterTokens)
    || (marker.status !== "created" && marker.status !== "recovered")
  ) {
    return null;
  }
  return {
    trigger: marker.trigger,
    createdAt: marker.createdAt,
    coverageThroughRunId: marker.coverageThroughRunId,
    beforeTokens: marker.beforeTokens,
    afterTokens: marker.afterTokens,
    status: marker.status,
  };
}

export function getRuntimeCompactionMarkerLabel(metadata: unknown): string | null {
  const marker = getRuntimeCompactionMarkerView(metadata);
  if (!marker) return null;
  if (marker.status === "recovered" || marker.trigger === "provider_overflow") {
    return "上下文超限后已压缩并重试";
  }
  return marker.trigger === "manual"
    ? "已手动压缩较早上下文"
    : "已自动压缩较早上下文";
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
