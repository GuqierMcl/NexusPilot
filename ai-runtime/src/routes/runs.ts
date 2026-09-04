import { Elysia } from "elysia";
import { detailError } from "../core/errors";
import {
  ProviderLanguageModelError,
  resolveProviderLanguageModel,
} from "../provider/language-model";
import type { ProviderService } from "../provider/service";
import {
  interruptStoredRun,
  RuntimeTextRunner,
  RuntimeConversationNotFoundError,
  RuntimeConversationBusyError,
  RuntimeMessageNotEditableError,
  RuntimePermissionResponseMismatchError,
  RuntimePermissionStrongConfirmationError,
  RuntimeContinuationLimitExceededError,
  RuntimeRunNotFoundError,
  RuntimeRunNotWaitingForPermissionError,
  RunContinuationConflictError,
  type RunContinuationRegistry,
  type ActiveRunRegistry,
  type InterruptReason,
  type InterruptStoredRunResult,
  type RuntimeResolvedLanguageModel,
  type RuntimeRunnerStore,
  type RuntimeStreamText,
  type GenerateConversationTitle,
  type RuntimeRunInterruptStore,
  type RunId,
  type BackendToolExecutor,
  type BackendBridgeRunState,
  type RuntimeToolRegistry,
  type PreparedToolInvocationRegistry,
  type RuntimeAttachmentService,
  RuntimeAttachmentError,
  attachmentErrorEnvelope,
} from "../runtime";
import {
  jsonRequestBody,
  stringSchema,
  unknownRecordSchema,
  type OpenApiSchema,
} from "./openapi";
import {
  parseRunContinueRequestBody,
  parseRunCreateRequestBody,
} from "./run-schema";
import type {
  RuntimeNetworkPolicy,
  RuntimeToolApprovalPolicy,
} from "../settings/contracts";

export interface RunRouteDeps {
  providerService: ProviderService | null;
  runtimeStore: (RuntimeRunnerStore & RuntimeRunInterruptStore) | null;
  appVersion?: string;
  resolveLanguageModel?: (input: {
    providerId: string;
    modelId: string;
  }) => RuntimeResolvedLanguageModel;
  streamText?: RuntimeStreamText;
  generateConversationTitle?: GenerateConversationTitle;
  toolRegistry?: RuntimeToolRegistry;
  backendToolExecutor?: BackendToolExecutor;
  preparedInvocations?: PreparedToolInvocationRegistry;
  backendBridgeState?: () => BackendBridgeRunState;
  activeRuns?: ActiveRunRegistry;
  continuations?: RunContinuationRegistry;
  getToolApprovalPolicy?: () => RuntimeToolApprovalPolicy;
  getNetworkPolicy?: () => RuntimeNetworkPolicy;
  attachmentService?: RuntimeAttachmentService | null;
}

export function runRoutes(deps: RunRouteDeps) {
  const getErrorMessageSecrets = deps.providerService
    ? () => deps.providerService!.listProviders()
        .flatMap((provider) => provider.apiKey ? [provider.apiKey] : [])
    : undefined;

  return new Elysia({ prefix: "/v1", name: "run-routes" })
    .post("/runs", async ({ request }) => {
      const body = await parseJsonBody(request);
      const parsed = parseRunCreateRequestBody(body);
      if (!parsed) {
        if (containsFileInputPart(body)) {
          return Response.json(
            {
              code: "ATTACHMENT_CORRUPT",
              message: "Run 的附件输入格式无效；只接受最终 attachment_id。",
            },
            { status: 422 },
          );
        }
        return detailError(422, "Invalid run creation request body");
      }

      if (!deps.runtimeStore) {
        return detailError(503, "Runtime Store not initialized");
      }

      const resolveLanguageModel =
        deps.resolveLanguageModel ?? createDefaultLanguageModelResolver(deps.providerService);
      if (!resolveLanguageModel) {
        return detailError(503, "ProviderService not initialized");
      }

      try {
        const runner = new RuntimeTextRunner({
          store: deps.runtimeStore,
          appVersion: deps.appVersion,
          resolveLanguageModel,
          streamText: deps.streamText,
          generateConversationTitle: deps.generateConversationTitle,
          toolRegistry: deps.toolRegistry,
          backendToolExecutor: deps.backendToolExecutor,
          preparedInvocations: deps.preparedInvocations,
          backendBridgeState: deps.backendBridgeState,
          activeRuns: deps.activeRuns,
          continuations: deps.continuations,
          getToolApprovalPolicy: deps.getToolApprovalPolicy,
          getNetworkPolicy: deps.getNetworkPolicy,
          getErrorMessageSecrets,
          attachmentService: deps.attachmentService ?? undefined,
        });

        if (parsed.responseMode === "stream") {
          return (await runner.streamText(parsed.runRequest, request.signal)).response;
        }

        return detailError(422, "Invalid run creation request body");
      } catch (error) {
        if (error instanceof ProviderLanguageModelError) {
          return detailError(error.status, error.message);
        }

        if (error instanceof RuntimeConversationNotFoundError) {
          return detailError(404, error.message);
        }

        if (error instanceof RuntimeAttachmentError) {
          return Response.json(attachmentErrorEnvelope(error), { status: error.status });
        }

        if (
          error instanceof RuntimeConversationBusyError ||
          error instanceof RuntimeMessageNotEditableError
        ) {
          return detailError(409, error.message);
        }

        throw error;
      }
    }, {
      detail: {
        tags: ["运行"],
        summary: "创建并流式执行 Run",
        description:
          "创建 Runtime Run。公开请求使用 agent_mode 表达内置 agent 运行模式，input.parts 接受有序 text part 与仅含最终 attachment_id 的 file part，并返回 AI SDK 兼容 UI message stream。",
        requestBody: jsonRequestBody(
          runCreateRequestSchema,
          "创建 Runtime Run 的请求参数。响应模式必须通过 body 字段显式声明，不使用 Accept header 协商。",
        ),
      },
    })
    .post("/runs/:runId/continue", async ({ params, request }) => {
      const body = await parseJsonBody(request);
      const parsed = parseRunContinueRequestBody(body);
      if (!parsed) {
        return detailError(422, "Invalid run continuation request body");
      }
      if (!deps.runtimeStore) {
        return detailError(503, "Runtime Store not initialized");
      }
      const resolveLanguageModel =
        deps.resolveLanguageModel ?? createDefaultLanguageModelResolver(deps.providerService);
      if (!resolveLanguageModel) {
        return detailError(503, "ProviderService not initialized");
      }

      try {
        const runner = new RuntimeTextRunner({
          store: deps.runtimeStore,
          appVersion: deps.appVersion,
          resolveLanguageModel,
          streamText: deps.streamText,
          generateConversationTitle: deps.generateConversationTitle,
          toolRegistry: deps.toolRegistry,
          backendToolExecutor: deps.backendToolExecutor,
          preparedInvocations: deps.preparedInvocations,
          backendBridgeState: deps.backendBridgeState,
          activeRuns: deps.activeRuns,
          continuations: deps.continuations,
          getToolApprovalPolicy: deps.getToolApprovalPolicy,
          getNetworkPolicy: deps.getNetworkPolicy,
          getErrorMessageSecrets,
          attachmentService: deps.attachmentService ?? undefined,
        });
        return (
          await runner.continueText(
            params.runId as RunId,
            parsed.permissionResponses,
            request.signal,
          )
        ).response;
      } catch (error) {
        if (error instanceof ProviderLanguageModelError) {
          return detailError(error.status, error.message);
        }
        if (error instanceof RuntimeRunNotFoundError) {
          return detailError(404, error.message);
        }
        if (
          error instanceof RuntimeRunNotWaitingForPermissionError ||
          error instanceof RunContinuationConflictError ||
          error instanceof RuntimeContinuationLimitExceededError
        ) {
          return detailError(409, error.message);
        }
        if (
          error instanceof RuntimePermissionResponseMismatchError ||
          error instanceof RuntimePermissionStrongConfirmationError
        ) {
          return detailError(422, error.message);
        }
        throw error;
      }
    }, {
      detail: {
        tags: ["运行"],
        summary: "提交 Permission 决策并继续 Run",
        description:
          "全量提交当前 Run 的 pending Permission 决策，并以同一 Run、Assistant Message、Tool Snapshot 与累计 limits 返回 AI SDK 兼容续跑流。",
        parameters: [runIdParameter],
        requestBody: jsonRequestBody(
          runContinueRequestSchema,
          "只接受 Runtime Permission ID 与用户决定；不接受客户端 message history。",
        ),
      },
    })
    .post("/runs/:runId/interrupt", async ({ params, request }) => {
      if (!deps.runtimeStore) {
        return detailError(503, "Runtime Store not initialized");
      }

      const body = await parseJsonBody(request);
      const parsed = parseInterruptRequestBody(body);
      if (!parsed) {
        return detailError(422, "Invalid run interrupt request body");
      }

      const runId = params.runId as RunId;
      const result =
        deps.activeRuns?.interruptRun(runId, parsed) ??
        interruptStoredRun({
          store: deps.runtimeStore,
          runId,
          reason: parsed.reason,
          message: parsed.message,
        });

      if (!result) {
        return detailError(404, `Run ${params.runId} not found`);
      }

      deps.preparedInvocations?.clearRun(result.run.id);
      await deps.backendToolExecutor?.cleanupRun?.(result.run.id);
      return projectInterruptResponse(result);
    }, {
      detail: {
        tags: ["运行"],
        summary: "中断 Runtime Run",
        description:
          "按明确 runId 中断正在执行或仍处于 active 状态的 Runtime Run。该接口是显式 command，不依赖 Accept header，也不通过 EventBus 发送命令。",
        parameters: [runIdParameter],
        requestBody: jsonRequestBody(
          runInterruptRequestSchema,
          "中断 Runtime Run 的请求参数；reason 默认 user_stop。",
        ),
      },
    });
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function createDefaultLanguageModelResolver(
  providerService: ProviderService | null,
): ((input: { providerId: string; modelId: string }) => RuntimeResolvedLanguageModel) | null {
  if (!providerService) {
    return null;
  }

  return (input) => resolveProviderLanguageModel(providerService, input);
}

interface RunInterruptRequestBody {
  reason: InterruptReason;
  message?: string;
  clientRequestId?: string;
}

function parseInterruptRequestBody(body: unknown): RunInterruptRequestBody | null {
  if (!isRecord(body)) {
    return null;
  }

  for (const key of Object.keys(body)) {
    if (key !== "reason" && key !== "message" && key !== "client_request_id") {
      return null;
    }
  }

  const reason = body.reason === undefined ? "user_stop" : body.reason;
  if (!isInterruptReason(reason)) {
    return null;
  }

  if (body.message !== undefined && typeof body.message !== "string") {
    return null;
  }

  if (body.client_request_id !== undefined && typeof body.client_request_id !== "string") {
    return null;
  }

  return {
    reason,
    ...(body.message ? { message: body.message } : {}),
    ...(body.client_request_id ? { clientRequestId: body.client_request_id } : {}),
  };
}

function projectInterruptResponse(result: InterruptStoredRunResult) {
  const interrupt = isRecord(result.run.metadata?.interrupt)
    ? result.run.metadata.interrupt
    : null;

  return {
    run_id: result.run.id,
    conversation_id: result.run.conversationId,
    status: result.run.status,
    interrupted: result.interrupted,
    interrupt: interrupt
      ? {
          reason: typeof interrupt.reason === "string" ? interrupt.reason : undefined,
          message: typeof interrupt.message === "string" ? interrupt.message : undefined,
          interrupted_at:
            typeof interrupt.interruptedAt === "string" ? interrupt.interruptedAt : undefined,
        }
      : null,
  };
}

function isInterruptReason(value: unknown): value is InterruptReason {
  return (
    value === "user_stop" ||
    value === "client_disconnect" ||
    value === "runtime_shutdown" ||
    value === "runtime_recovered_stale_run" ||
    value === "tool_abort" ||
    value === "timeout" ||
    value === "unknown"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const agentModeSchema: OpenApiSchema = {
  type: "string",
  enum: ["ask", "query", "agent"],
  description:
    "内置 agent 运行模式；ask 为默认问答，query 为数据库只读协作，agent 为完整受控工具协作。",
};

const runResponseModeSchema: OpenApiSchema = {
  type: "string",
  enum: ["stream"],
  description: "Phase 2 仅支持 stream。",
};

const runModelSelectionSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["provider_id", "model_id"],
  properties: {
    provider_id: {
      ...stringSchema,
      description: "Provider id。",
    },
    model_id: {
      ...stringSchema,
      description: "Model id。",
    },
  },
};

const runInputTextPartSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "text"],
  properties: {
    type: {
      type: "string",
      enum: ["text"],
      description: "文本 part。",
    },
    text: {
      ...stringSchema,
      description: "用户输入文本。",
    },
  },
};

const runInputFilePartSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "attachment_id"],
  properties: {
    type: {
      type: "string",
      enum: ["file"],
      description: "已完成上传的附件 part。",
    },
    attachment_id: {
      ...stringSchema,
      pattern: "^att_.+$",
      description: "专用上传 API 返回的最终 Attachment ID。",
    },
  },
};

const runInputSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["parts"],
  properties: {
    parts: {
      type: "array",
      minItems: 1,
      description: "保持用户输入顺序的 text/file part 列表。",
      items: {
        oneOf: [runInputTextPartSchema, runInputFilePartSchema],
      },
    },
  },
};

function containsFileInputPart(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = (value as Record<string, unknown>).input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const parts = (input as Record<string, unknown>).parts;
  return Array.isArray(parts) && parts.some(
    (part) => typeof part === "object" && part !== null &&
      !Array.isArray(part) && (part as Record<string, unknown>).type === "file",
  );
}

const runCreateRequestSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["response_mode", "model", "input"],
  properties: {
    response_mode: runResponseModeSchema,
    conversation_id: {
      ...stringSchema,
      description: "已有 runtime conversation id；省略时创建新对话。",
    },
    replace_from_message_id: {
      ...stringSchema,
      description:
        "编辑既有用户消息后从该处继续时的目标 message id；携带时必须同时提供 conversation_id。Runtime 会移除该消息及其后的会话历史，再创建新的 Run。",
    },
    model: runModelSelectionSchema,
    agent_mode: agentModeSchema,
    input: runInputSchema,
    metadata: {
      ...unknownRecordSchema,
      description: "调用方附加的轻量 trace/debug 元数据。",
    },
  },
};

const runInterruptRequestSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: {
      type: "string",
      enum: [
        "user_stop",
        "client_disconnect",
        "runtime_shutdown",
        "runtime_recovered_stale_run",
        "tool_abort",
        "timeout",
        "unknown",
      ],
      description: "中断原因；前端用户停止默认使用 user_stop。",
    },
    message: {
      ...stringSchema,
      description: "可选中断说明，用于 trace/debug。",
    },
    client_request_id: {
      ...stringSchema,
      description: "可选客户端请求 id，用于调用方侧幂等追踪；Runtime 第一版不依赖它判断事实状态。",
    },
  },
};

const runContinueRequestSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["permission_responses"],
  properties: {
    permission_responses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["permission_id", "approved"],
        properties: {
          permission_id: {
            ...stringSchema,
            description: "Runtime canonical Permission ID。",
          },
          approved: {
            type: "boolean",
            description: "用户是否批准这一次 ToolCall。",
          },
          confirmation_text: {
            ...stringSchema,
            description: "预留给 strong confirmation 的精确确认文本。",
          },
          reason: {
            ...stringSchema,
            description: "可选用户决定原因。",
          },
        },
      },
    },
  },
};

const runIdParameter = {
  name: "runId",
  in: "path" as const,
  required: true,
  description: "Runtime run id。",
  schema: { type: "string" },
} as const;
