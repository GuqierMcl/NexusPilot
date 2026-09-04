import { createHash } from "node:crypto";
import type {
  ConversationId,
  Permission,
  RunId,
  ToolCall,
  ToolCallAuthorizationPresentationSnapshot,
} from "../core/types";
import { RUNTIME_SAFETY_STATE_VERSION } from "./policy";
import { estimateJsonTokens, stableStringifyJson } from "./token-estimator";
import type {
  RuntimeSafetyEffect,
  RuntimeSafetyPermissionAudit,
  RuntimeSafetyRisk,
  RuntimeSafetyState,
  RuntimeSafetyTarget,
} from "./types";

export interface RuntimeSafetyStateInput {
  conversationId: ConversationId;
  activeRunIds: readonly RunId[];
  toolCalls: readonly ToolCall[];
  permissions: readonly Permission[];
  maxTokens?: number;
}

export class RuntimeSafetyStateBudgetError extends Error {
  constructor(
    readonly requiredTokens: number,
    readonly maxTokens: number,
  ) {
    super(
      `Runtime Safety State exceeds its assigned token budget: `
      + `${requiredTokens} required, ${maxTokens} available`,
    );
    this.name = "RuntimeSafetyStateBudgetError";
  }
}

export function buildRuntimeSafetyState(input: RuntimeSafetyStateInput): RuntimeSafetyState {
  const activeRunIds = new Set(input.activeRunIds);
  const permissions = input.permissions
    .filter((permission) => permission.conversationId === input.conversationId)
    .sort(comparePermissions);
  const permissionByToolCallId = new Map<ToolCall["id"], Permission>();
  for (const permission of permissions) {
    if (permissionByToolCallId.has(permission.toolCallId)) {
      throw new Error(`Duplicate Runtime Permission for ToolCall ${permission.toolCallId}`);
    }
    permissionByToolCallId.set(permission.toolCallId, permission);
  }
  const effects = input.toolCalls
    .filter((toolCall) => toolCall.conversationId === input.conversationId)
    .map((toolCall) => {
      const permission = resolveBoundPermission(toolCall, permissionByToolCallId.get(toolCall.id));
      return projectEffect(toolCall, permission, activeRunIds);
    })
    .filter((effect): effect is RuntimeSafetyEffect => effect !== null)
    .sort(compareEffects);
  const permissionAudits = permissions.map(projectPermissionAudit);
  const facts = {
    version: RUNTIME_SAFETY_STATE_VERSION,
    conversationId: input.conversationId,
    effects,
    permissions: permissionAudits,
  };
  const state: RuntimeSafetyState = {
    ...facts,
    hash: `sha256:${createHash("sha256").update(stableStringifyJson(facts)).digest("hex")}`,
  };
  if (input.maxTokens !== undefined) {
    if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 0) {
      throw new Error("Runtime Safety State maxTokens must be a non-negative integer");
    }
    const requiredTokens = estimateJsonTokens(state);
    if (requiredTokens > input.maxTokens) {
      throw new RuntimeSafetyStateBudgetError(requiredTokens, input.maxTokens);
    }
  }
  return state;
}

function resolveBoundPermission(
  toolCall: ToolCall,
  permission: Permission | undefined,
): Permission | undefined {
  if (
    !permission
    || permission.conversationId !== toolCall.conversationId
    || permission.runId !== toolCall.runId
    || permission.messageId !== toolCall.messageId
    || permission.toolCallId !== toolCall.id
    || permission.toolId !== toolCall.toolName
    || toolCall.permissionId !== permission.id
  ) {
    return undefined;
  }
  return permission;
}

function projectEffect(
  toolCall: ToolCall,
  permission: Permission | undefined,
  activeRunIds: ReadonlySet<RunId>,
): RuntimeSafetyEffect | null {
  if (
    toolCall.state === "error"
    && (toolCall.error?.outcome === "not_started" || toolCall.error?.outcome === "no_effect")
  ) {
    return null;
  }

  const authorization = permission
    ? { risk: permission.risk, presentation: permission.presentation }
    : toolCall.authorization?.version === "1"
      ? toolCall.authorization
      : undefined;
  const risk: RuntimeSafetyRisk = authorization
    ? {
        level: authorization.risk.level,
        reversible: authorization.risk.reversible,
        sideEffects: [...authorization.risk.sideEffects].sort(compareSideEffects),
      }
    : { level: "unknown", reversible: "unknown", sideEffects: ["unknown"] };
  if (
    authorization
    && risk.sideEffects.every((sideEffect) =>
      sideEffect === "none" || sideEffect === "business_read",
    )
  ) {
    return null;
  }

  const { outcome, certainty } = resolveEffectOutcome(toolCall, authorization !== undefined);
  return {
    toolCallId: toolCall.id,
    runId: toolCall.runId,
    operation: toolCall.toolName,
    activeLineage: activeRunIds.has(toolCall.runId),
    risk,
    target: projectAuthorizationTarget(authorization?.presentation),
    outcome,
    certainty,
  };
}

function resolveEffectOutcome(
  toolCall: ToolCall,
  hasStructuredRisk: boolean,
): Pick<RuntimeSafetyEffect, "outcome" | "certainty"> {
  if (toolCall.state === "completed") {
    return {
      outcome: toolCall.result?.ok === true ? "completed" : "unknown",
      certainty: toolCall.result?.ok === true && hasStructuredRisk ? "confirmed" : "uncertain",
    };
  }
  if (toolCall.state === "running") {
    return { outcome: "running", certainty: "uncertain" };
  }
  if (
    toolCall.state === "pending"
    || toolCall.state === "validating"
    || toolCall.state === "waiting_for_permission"
  ) {
    return { outcome: "waiting", certainty: "uncertain" };
  }
  if (toolCall.error?.outcome === "unknown" || toolCall.time.started !== undefined) {
    return { outcome: "possibly_executed", certainty: "uncertain" };
  }
  return { outcome: "unknown", certainty: "uncertain" };
}

function projectAuthorizationTarget(
  presentation: ToolCallAuthorizationPresentationSnapshot | undefined,
): RuntimeSafetyTarget {
  const target = presentation?.target;
  const sqlTargets = presentation?.sql?.identifiedTargets;
  const keyValue = presentation?.keyValue;
  if (!target && !sqlTargets?.length && !keyValue) {
    return { kind: "unknown" };
  }
  return {
    kind: "structured",
    ...(target?.profileId ? { profileId: target.profileId } : {}),
    ...(target?.connectionName ? { connectionName: target.connectionName } : {}),
    ...(target?.driver ? { driver: target.driver } : {}),
    ...(target?.environment ? { environment: target.environment } : {}),
    ...(target?.database ? { database: target.database } : {}),
    ...(target?.schema ? { schema: target.schema } : {}),
    ...(target?.redisDbIndex !== undefined ? { redisDbIndex: target.redisDbIndex } : {}),
    ...(sqlTargets?.length
      ? { identifiedTargets: [...sqlTargets].sort((left, right) => left.localeCompare(right)) }
      : {}),
    ...(keyValue ? { key: keyValue.key } : {}),
    ...(keyValue?.newKey ? { newKey: keyValue.newKey } : {}),
  };
}

function projectPermissionAudit(permission: Permission): RuntimeSafetyPermissionAudit {
  return {
    permissionId: permission.id,
    toolCallId: permission.toolCallId,
    runId: permission.runId,
    status: permission.status,
    ...(permission.decision?.source ? { decisionSource: permission.decision.source } : {}),
    ...(permission.decision?.confirmationVerified !== undefined
      ? { confirmationVerified: permission.decision.confirmationVerified }
      : {}),
    nonTransferable: true,
  };
}

const RISK_ORDER: Record<RuntimeSafetyRisk["level"], number> = {
  unknown: 0,
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
};

function compareEffects(left: RuntimeSafetyEffect, right: RuntimeSafetyEffect): number {
  return RISK_ORDER[left.risk.level] - RISK_ORDER[right.risk.level]
    || Number(left.certainty === "confirmed") - Number(right.certainty === "confirmed")
    || left.runId.localeCompare(right.runId)
    || left.toolCallId.localeCompare(right.toolCallId);
}

function comparePermissions(left: Permission, right: Permission): number {
  return left.runId.localeCompare(right.runId)
    || left.toolCallId.localeCompare(right.toolCallId)
    || left.id.localeCompare(right.id);
}

const SIDE_EFFECT_ORDER = [
  "unknown",
  "destructive",
  "business_write",
  "workbench_state",
  "runtime_state",
  "external_network",
  "business_read",
  "none",
] as const;

function compareSideEffects(
  left: RuntimeSafetyRisk["sideEffects"][number],
  right: RuntimeSafetyRisk["sideEffects"][number],
): number {
  return SIDE_EFFECT_ORDER.indexOf(left) - SIDE_EFFECT_ORDER.indexOf(right);
}
