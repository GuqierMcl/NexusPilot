import type { Conversation, Message, Permission, Run } from "../core/types";
import { projectMessageToAiSdkUIMessage, type AiSdkUIMessageLike } from "./ai-sdk-projection";
import { projectMessageToUiMessage, type UiMessageLike } from "./ui-projection";

export type MessageHistoryFormat = "runtime" | "ui" | "ai_sdk";

export interface ConversationSummarySnapshot {
  id: string;
  title: string;
  status: Conversation["status"];
  active_run_id?: string;
  time: Conversation["time"];
  metadata?: Record<string, unknown>;
}

export interface RunSnapshot {
  id: string;
  conversation_id: string;
  agent_mode: Run["agentMode"];
  provider_id: string;
  model_id: string;
  status: Run["status"];
  input: Run["input"];
  output?: Run["output"];
  usage?: Run["usage"];
  cost?: Run["cost"];
  finish?: Run["finish"];
  error?: Run["error"];
  time: Run["time"];
  limits: Run["limits"];
  metadata?: Record<string, unknown>;
}

export function projectPermissionSnapshot(permission: Permission) {
  const target = permission.presentation?.target;
  const sql = permission.presentation?.sql;
  return {
    id: permission.id,
    run_id: permission.runId,
    message_id: permission.messageId,
    tool_call_id: permission.toolCallId,
    status: permission.status,
    tool_id: permission.toolId,
    title: permission.title,
    ...(permission.inputSummary
      ? { input_summary: permission.inputSummary }
      : {}),
    risk: permission.risk,
    confirmation: permission.confirmation,
    ...(permission.presentation
      ? {
          presentation: {
            ...(target
              ? {
                  target: {
                    ...(target.profileId
                      ? { profile_id: target.profileId }
                      : {}),
                    ...(target.connectionName
                      ? { connection_name: target.connectionName }
                      : {}),
                    ...(target.driver ? { driver: target.driver } : {}),
                    ...(target.environment
                      ? { environment: target.environment }
                      : {}),
                    ...(target.database ? { database: target.database } : {}),
                    ...(target.schema ? { schema: target.schema } : {}),
                    ...(target.redisDbIndex !== undefined
                      ? { redis_db_index: target.redisDbIndex }
                      : {}),
                  },
                }
              : {}),
            ...(permission.presentation.riskReasons
              ? { risk_reasons: permission.presentation.riskReasons }
              : {}),
            ...(sql
              ? {
                  sql: {
                    text: sql.text,
                    analysis_status: sql.analysisStatus,
                    ...(sql.statementClass
                      ? { statement_class: sql.statementClass }
                      : {}),
                    ...(sql.identifiedTargets
                      ? { identified_targets: sql.identifiedTargets }
                      : {}),
                  },
                }
              : {}),
            ...(permission.presentation.keyValue
              ? {
                  key_value: {
                    operation: permission.presentation.keyValue.operation,
                    key: permission.presentation.keyValue.key,
                    ...(permission.presentation.keyValue.newKey
                      ? { new_key: permission.presentation.keyValue.newKey }
                      : {}),
                    ...(permission.presentation.keyValue.valueType
                      ? { value_type: permission.presentation.keyValue.valueType }
                      : {}),
                    ...(permission.presentation.keyValue.ttlMode
                      ? { ttl_mode: permission.presentation.keyValue.ttlMode }
                      : {}),
                    ...(permission.presentation.keyValue.ttlSeconds !== undefined
                      ? { ttl_seconds: permission.presentation.keyValue.ttlSeconds }
                      : {}),
                  },
                }
              : {}),
            ...(permission.presentation.timeoutMs !== undefined
              ? { timeout_ms: permission.presentation.timeoutMs }
              : {}),
            ...(permission.presentation.maxResultBytes !== undefined
              ? { max_result_bytes: permission.presentation.maxResultBytes }
              : {}),
            ...(permission.presentation.outcomeWarnings
              ? { outcome_warnings: permission.presentation.outcomeWarnings }
              : {}),
          },
        }
      : {}),
    created_at: permission.createdAt,
  };
}

export type MessageHistoryProjection = Message[] | UiMessageLike[] | AiSdkUIMessageLike[];

export function projectConversationSummary(
  conversation: Conversation,
): ConversationSummarySnapshot {
  const activeRunId = getActiveRunId(conversation.status);

  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    ...(activeRunId ? { active_run_id: activeRunId } : {}),
    time: conversation.time,
    ...(conversation.metadata ? { metadata: conversation.metadata } : {}),
  };
}

export function projectRunSnapshot(run: Run): RunSnapshot {
  return {
    id: run.id,
    conversation_id: run.conversationId,
    agent_mode: run.agentMode,
    provider_id: run.providerId,
    model_id: run.modelId,
    status: run.status,
    input: run.input,
    ...(run.output ? { output: run.output } : {}),
    ...(run.usage ? { usage: run.usage } : {}),
    ...(run.cost ? { cost: run.cost } : {}),
    ...(run.finish ? { finish: run.finish } : {}),
    ...(run.error ? { error: run.error } : {}),
    time: run.time,
    limits: run.limits,
    ...(run.metadata ? { metadata: run.metadata } : {}),
  };
}

export function projectMessageHistory(
  messages: Message[],
  format: MessageHistoryFormat,
): MessageHistoryProjection {
  if (format === "ui") {
    return messages.map(projectMessageToUiMessage);
  }

  if (format === "ai_sdk") {
    return messages.map(projectMessageToAiSdkUIMessage);
  }

  return messages;
}

export function parseMessageHistoryFormat(value: unknown): MessageHistoryFormat | null {
  if (value === undefined) {
    return "runtime";
  }

  if (value === "runtime" || value === "ui" || value === "ai_sdk") {
    return value;
  }

  return null;
}

function getActiveRunId(status: Conversation["status"]): string | undefined {
  if (status.type === "busy" || status.type === "waiting_for_permission") {
    return status.runId;
  }

  return undefined;
}
