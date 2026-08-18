import {
  BackendBridgeRequestError,
  type BackendBridgeManager,
} from "../../backend-bridge";
import {
  RuntimeToolExecutionError,
  type BackendToolExecutor,
} from "./core";
import type { ToolExecutionOutput } from "./contracts";
import type {
  BackendToolExecutionIdentity,
  PreparedToolInvocation,
} from "./contracts";
import { z } from "zod";

export interface BackendBridgeRequester {
  request(
    operation: string,
    input: unknown,
    signal?: AbortSignal,
    identity?: BackendToolExecutionIdentity,
  ): Promise<unknown>;
}

export class BackendBridgeToolExecutor implements BackendToolExecutor {
  constructor(
    private readonly bridge: BackendBridgeRequester,
  ) {}

  async execute(
    operation: string,
    input: unknown,
    signal: AbortSignal,
    identity?: BackendToolExecutionIdentity,
  ): Promise<ToolExecutionOutput<unknown>> {
    try {
      const data = await this.bridge.request(operation, input, signal, identity);
      return {
        summary: "Backend operation completed.",
        data,
      };
    } catch (error) {
      if (error instanceof BackendBridgeRequestError) {
        throw new RuntimeToolExecutionError(
          error.code,
          error.message,
          error.retryable,
          error.outcome,
        );
      }
      throw new RuntimeToolExecutionError(
        "BACKEND_EXECUTION_FAILED",
        "Backend operation failed.",
        false,
        "unknown",
      );
    }
  }

  async prepare(
    operation: string,
    input: unknown,
    identity: BackendToolExecutionIdentity,
    signal: AbortSignal,
  ): Promise<PreparedToolInvocation> {
    try {
      const data = await this.bridge.request(operation, input, signal, identity);
      return preparedToolInvocationSchema.parse(data) as PreparedToolInvocation;
    } catch (error) {
      if (error instanceof BackendBridgeRequestError) {
        throw new RuntimeToolExecutionError(
          error.code,
          error.message,
          error.retryable,
          error.outcome,
        );
      }
      if (error instanceof z.ZodError) {
        throw new RuntimeToolExecutionError(
          "PLAN_MISMATCH",
          "Backend returned an invalid prepared plan.",
          false,
          "not_started",
        );
      }
      throw new RuntimeToolExecutionError(
        "BACKEND_PREPARE_FAILED",
        "Backend prepare operation failed.",
        false,
        "not_started",
      );
    }
  }

  async cleanupRun(runId: BackendToolExecutionIdentity["runId"]): Promise<void> {
    try {
      await this.bridge.request(
        "prepared_plan.cleanup_run",
        {},
        undefined,
        {
          conversationId: "conv_internal_cleanup" as BackendToolExecutionIdentity["conversationId"],
          runId,
          messageId: "msg_internal_cleanup" as BackendToolExecutionIdentity["messageId"],
          toolCallId: "tool_internal_cleanup" as BackendToolExecutionIdentity["toolCallId"],
          toolId: "prepared_plan.cleanup_run",
        },
      );
    } catch {
      // Cleanup is best effort; Rust also clears plans on Bridge disconnect.
    }
  }
}

export function createBackendBridgeToolExecutor(
  bridge: BackendBridgeManager,
): BackendBridgeToolExecutor {
  return new BackendBridgeToolExecutor(bridge);
}

const riskSchema = z.object({
  level: z.enum(["low", "medium", "high", "critical"]),
  reversible: z.boolean(),
  sideEffects: z.array(z.enum([
    "none",
    "external_network",
    "runtime_state",
    "workbench_state",
    "business_read",
    "business_write",
    "destructive",
  ])),
});

const preparedToolInvocationSchema = z.object({
  planId: z.string().min(1),
  expiresAt: z.number().int().positive(),
  risk: riskSchema,
  permission: z.object({
    inputSummary: z.string().optional(),
    confirmationPrompt: z.string().optional(),
    presentation: z.object({
      target: z.object({
        profileId: z.string().optional(),
        connectionName: z.string().optional(),
        driver: z.string().optional(),
        environment: z.string().optional(),
        database: z.string().optional(),
        schema: z.string().optional(),
        redisDbIndex: z.number().int().nonnegative().optional(),
      }).optional(),
      riskReasons: z.array(z.string()).optional(),
      sql: z.object({
        text: z.string(),
        analysisStatus: z.enum(["analyzed", "uncertain", "failed"]),
        statementClass: z.string().optional(),
        identifiedTargets: z.array(z.string()).optional(),
      }).optional(),
      keyValue: z.object({
        operation: z.enum(["create", "set", "rename", "set_ttl", "delete"]),
        key: z.string(),
        newKey: z.string().optional(),
        valueType: z.string().optional(),
        ttlMode: z.enum(["keep", "persist", "expire"]).optional(),
        ttlSeconds: z.number().int().positive().optional(),
      }).optional(),
      timeoutMs: z.number().int().positive().optional(),
      maxResultBytes: z.number().int().positive().optional(),
      outcomeWarnings: z.array(z.string()).optional(),
    }).optional(),
  }),
});
