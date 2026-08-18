import type { AiRuntimeHealthStatus } from "@/store/slices/ai-runtime-endpoint-slice";

export type AgentComposerSendBlockerCode =
  | "runtime_unavailable"
  | "running"
  | "recovering"
  | "missing_model"
  | "model_unavailable"
  | "adapter_error";

export interface AgentComposerSendBlocker {
  code: AgentComposerSendBlockerCode;
  message: string;
}

export interface AgentComposerSendBlockerInput {
  runtimeAvailable: boolean;
  runtimeChecking: boolean;
  threadRunning: boolean;
  threadRecovering: boolean;
  modelPreferenceSelected: boolean;
  selectedModelAvailable: boolean;
  modelAvailabilityKnown: boolean;
  adapterErrorMessage: string | null;
}

export interface AiRuntimeAvailabilityOverlayInput {
  endpointKnown: boolean;
  healthStatus: AiRuntimeHealthStatus;
  isChecking: boolean;
  errorMessage: string | null;
}

export interface AiRuntimeAvailabilityOverlay {
  kind: "checking" | "starting" | "unavailable";
  title: string;
  description: string;
}

export type RuntimeMessageStatusView =
  | {
      kind: "interrupted";
      label: "执行已中断";
      description: string;
    }
  | {
      kind: "failed";
      label: "执行失败";
      description: string;
    };

const RUNTIME_UNAVAILABLE_DESCRIPTION = "请稍候，或检查本地 sidecar 状态。";

export function getAiRuntimeAvailabilityOverlay(
  input: AiRuntimeAvailabilityOverlayInput,
): AiRuntimeAvailabilityOverlay | null {
  if (input.healthStatus === "healthy") {
    return null;
  }

  if (input.isChecking) {
    return {
      kind: "checking",
      title: "正在连接 AI Runtime...",
      description: "请稍候，服务就绪后会自动恢复。",
    };
  }

  if (!input.endpointKnown) {
    return {
      kind: "starting",
      title: "AI Runtime 正在启动...",
      description: RUNTIME_UNAVAILABLE_DESCRIPTION,
    };
  }

  return {
    kind: "unavailable",
    title: "AI Runtime 暂不可用",
    description: RUNTIME_UNAVAILABLE_DESCRIPTION,
  };
}

export function getAgentComposerSendBlocker(
  input: AgentComposerSendBlockerInput,
): AgentComposerSendBlocker | null {
  if (!input.runtimeAvailable) {
    return {
      code: "runtime_unavailable",
      message: "AI Runtime 暂不可用",
    };
  }

  if (input.threadRunning) {
    return { code: "running", message: "正在生成" };
  }

  if (input.threadRecovering) {
    return { code: "recovering", message: "正在恢复对话" };
  }

  if (!input.modelPreferenceSelected) {
    return { code: "missing_model", message: "请选择模型" };
  }

  if (input.modelAvailabilityKnown && !input.selectedModelAvailable) {
    return { code: "model_unavailable", message: "当前模型不可用" };
  }

  const adapterMessage = normalizeOptionalString(input.adapterErrorMessage);
  if (adapterMessage) {
    return { code: "adapter_error", message: adapterMessage };
  }

  return null;
}

export function getRuntimeMessageStatusView(
  metadata: unknown,
): RuntimeMessageStatusView | null {
  const nexus = readNexusMetadata(metadata);
  const status = readRecord(nexus?.status);
  const statusType = typeof status?.type === "string" ? status.type : null;

  if (statusType === "incomplete") {
    const reason =
      typeof status?.reason === "string" ? status.reason.toLowerCase() : "";
    const interrupt = readRecord(nexus?.interrupt);

    if (reason === "interrupted" || interrupt) {
      return {
        kind: "interrupted",
        label: "执行已中断",
        description: "生成已中断",
      };
    }
  }

  if (statusType === "error") {
    return {
      kind: "failed",
      label: "执行失败",
      description: readRuntimeErrorMessage(status?.error) ?? "运行失败，请稍后重试。",
    };
  }

  return null;
}

function readNexusMetadata(metadata: unknown): Record<string, unknown> | null {
  const root = readRecord(metadata);
  const directNexus = readRecord(root?.nexus);
  if (directNexus) {
    return directNexus;
  }

  const custom = readRecord(root?.custom);
  return readRecord(custom?.nexus);
}

function readRuntimeErrorMessage(value: unknown): string | null {
  const error = readRecord(value);
  const data = readRecord(error?.data);

  return normalizeOptionalString(data?.message) ?? normalizeOptionalString(error?.message);
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
