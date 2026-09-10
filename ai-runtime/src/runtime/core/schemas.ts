import { z } from "zod";
import { activeTabContextSchema } from "../../../../shared/active-tab-context";
import { commandBindingSchema } from "../../../../shared/composer-commands";
import { textReferencesSchema, validateReferenceMessage } from "../../../../shared/composer-references";
import { DEFAULT_CONTEXT_COMPACTION_POLICY } from "../context/policy";

const unknownRecordSchema = z.record(z.string(), z.unknown());
const optionalUnknownRecordSchema = unknownRecordSchema.optional();

export const messageHistoryViewSchema = z.enum(["active", "transcript"]);

export const timeCreatedSchema = z.object({
  created: z.number(),
});

export const timeSpanSchema = z.object({
  start: z.number(),
  end: z.number().optional(),
});

export const runtimeErrorSchema = z.union([
  z.object({
    name: z.literal("ProviderAuthError"),
    data: z.object({ providerId: z.string(), message: z.string() }),
  }),
  z.object({
    name: z.literal("ProviderNotFoundError"),
    data: z.object({ providerId: z.string() }),
  }),
  z.object({
    name: z.literal("ModelNotFoundError"),
    data: z.object({ providerId: z.string(), modelId: z.string() }),
  }),
  z.object({
    name: z.literal("ModelDisabledError"),
    data: z.object({ providerId: z.string(), modelId: z.string() }),
  }),
  z.object({
    name: z.literal("APIError"),
    data: z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean().optional(),
    }),
  }),
  z.object({
    name: z.literal("MessageOutputLengthError"),
    data: z.object({ limit: z.number().optional(), message: z.string().optional() }),
  }),
  z.object({
    name: z.literal("MessageAbortedError"),
    data: z.object({ message: z.string() }),
  }),
  z.object({
    name: z.literal("ToolExecutionError"),
    data: z.object({
      toolName: z.string(),
      message: z.string(),
      code: z.string().optional(),
    }),
  }),
  z.object({
    name: z.literal("PermissionDeniedError"),
    data: z.object({ permissionId: z.string().optional(), message: z.string() }),
  }),
  z.object({
    name: z.literal("UnknownError"),
    data: z.object({ message: z.string() }),
  }),
  z.object({
    name: z.string().min(1),
    data: z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean().optional(),
    }),
  }),
]);

export const conversationStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy"), runId: z.string() }),
  z.object({
    type: z.literal("waiting_for_permission"),
    runId: z.string(),
    permissionId: z.string(),
  }),
  z.object({
    type: z.literal("retry"),
    attempt: z.number(),
    message: z.string(),
    next: z.number(),
  }),
  z.object({ type: z.literal("error"), error: runtimeErrorSchema }),
  z.object({ type: z.literal("archived") }),
]);

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.string(),
  status: conversationStatusSchema,
  activeHeadRunId: z.string().optional(),
  revision: z.number().int().nonnegative(),
  parentId: z.string().optional(),
  summary: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
      messageCount: z.number().optional(),
      tokenCount: z.number().optional(),
      toolCallCount: z.number().optional(),
      updatedAt: z.number(),
    })
    .optional(),
  share: z.object({ url: z.string(), createdAt: z.number() }).optional(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
    archived: z.number().optional(),
    compacting: z.number().optional(),
  }),
  metadata: optionalUnknownRecordSchema,
});

export const tokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache: z.object({ read: z.number(), write: z.number() }).optional(),
  total: z.number(),
});

export const costUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  total: z.number().optional(),
  currency: z.string().optional(),
});

export const interruptReasonSchema = z.enum([
  "user_stop",
  "client_disconnect",
  "runtime_shutdown",
  "runtime_recovered_stale_run",
  "tool_abort",
  "timeout",
  "unknown",
]);

export const finishReasonSchema = z.enum([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "interrupted",
  "unknown",
]);

const agentModeSchema = z.enum(["ask", "query", "agent"]);

const promptAssemblySnapshotSchema = z
  .object({
    version: z.string(),
    blockIds: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();

const runToolSnapshotSchema = z
  .object({
    snapshotId: z.string().min(1),
    runId: z.string().startsWith("run_"),
    createdAt: z.string().datetime(),
    agentMode: z.enum(["ask", "query", "agent"]),
    executionCeiling: z
      .object({
        maxRiskLevel: z.enum(["low", "medium", "high", "critical"]),
        allowedSideEffects: z.array(
          z.enum([
            "none",
            "external_network",
            "runtime_state",
            "workbench_state",
            "business_read",
            "business_write",
            "destructive",
          ]),
        ),
        allowIrreversible: z.boolean(),
      })
      .strict(),
    approvalPolicy: z
      .object({
        autoApproveMaxRisk: z.enum(["none", "low", "medium"]),
      })
      .strict()
      .optional(),
    networkPolicy: z
      .object({
        accessScope: z.enum(["local-and-public", "public-only"]),
      })
      .strict()
      .optional(),
    activeTools: z.array(
      z
        .object({
          canonicalId: z.string().min(1),
          providerName: z.string().min(1),
        })
        .strict(),
    ),
    unavailableTools: z
      .array(
        z
          .object({
            canonicalId: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const runSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    parentRunId: z.string().optional(),
    supersedesRunId: z.string().optional(),
    parentMessageId: z.string().optional(),
    assistantMessageId: z.string().optional(),
    agentMode: agentModeSchema,
    providerId: z.string(),
    modelId: z.string(),
    status: z.enum([
      "queued",
      "running",
      "waiting_for_tool",
      "waiting_for_permission",
      "completed",
      "failed",
      "interrupted",
    ]),
    input: z
      .object({
        messageIds: z.array(z.string()),
        prompt: promptAssemblySnapshotSchema.optional(),
        tools: runToolSnapshotSchema.optional(),
        context: unknownRecordSchema.optional(),
      })
      .strict(),
    output: z.object({ messageId: z.string(), partIds: z.array(z.string()) }).optional(),
    usage: tokenUsageSchema.optional(),
    cost: costUsageSchema.optional(),
    finish: finishReasonSchema.optional(),
    error: runtimeErrorSchema.optional(),
    time: z.object({
      created: z.number(),
      started: z.number().optional(),
      completed: z.number().optional(),
    }),
    limits: z.object({
      maxSteps: z.number(),
      maxToolCalls: z.number(),
      maxOutputTokens: z.number().optional(),
      timeoutMs: z.number().optional(),
    }),
    metadata: optionalUnknownRecordSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.parentRunId === run.id) {
      context.addIssue({
        code: "custom",
        path: ["parentRunId"],
        message: "Run cannot be its own parent",
      });
    }
    if (run.supersedesRunId === run.id) {
      context.addIssue({
        code: "custom",
        path: ["supersedesRunId"],
        message: "Run cannot supersede itself",
      });
    }
  });

const diffLineSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("context"),
    oldLine: z.number(),
    newLine: z.number(),
    text: z.string(),
  }),
  z.object({ type: z.literal("add"), newLine: z.number(), text: z.string() }),
  z.object({ type: z.literal("remove"), oldLine: z.number(), text: z.string() }),
]);

const diffTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("memory"), name: z.string(), language: z.string().optional() }),
  z.object({
    type: z.literal("workspace_file"),
    path: z.string(),
    language: z.string().optional(),
  }),
  z.object({
    type: z.literal("business_object"),
    objectType: z.string(),
    objectId: z.string(),
    label: z.string().optional(),
  }),
]);

export const diffArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["text", "sql", "json", "markdown"]),
  target: diffTargetSchema,
  beforeHash: z.string().optional(),
  afterHash: z.string().optional(),
  hunks: z.array(
    z.object({
      oldStart: z.number(),
      oldLines: z.number(),
      newStart: z.number(),
      newLines: z.number(),
      lines: z.array(diffLineSchema),
    }),
  ),
  summary: z.string().optional(),
});

const toolErrorSchema = z.object({
  code: z.enum([
    "VALIDATION_ERROR",
    "NETWORK_ACCESS_SCOPE_DENIED",
    "PERMISSION_DENIED",
    "TIMEOUT",
    "NETWORK_ERROR",
    "HTTP_ERROR",
    "CONTENT_TOO_LARGE",
    "UNSUPPORTED_CONTENT_TYPE",
    "INTERNAL_ERROR",
  ]),
  message: z.string(),
  retryable: z.boolean(),
  details: optionalUnknownRecordSchema,
});

const toolOutputSchema = z.object({
  data: z.unknown(),
  display: z
    .object({
      title: z.string().optional(),
      summary: z.string().optional(),
      markdown: z.string().optional(),
      sourceUrl: z.string().optional(),
    })
    .optional(),
});

const toolStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    input: optionalUnknownRecordSchema,
    raw: z.string().optional(),
  }),
  z.object({ status: z.literal("validating"), input: unknownRecordSchema, time: timeSpanSchema }),
  z.object({
    status: z.literal("waiting_for_permission"),
    input: unknownRecordSchema,
    permissionId: z.string(),
    title: z.string().optional(),
    metadata: optionalUnknownRecordSchema,
    time: timeSpanSchema,
  }),
  z.object({
    status: z.literal("running"),
    input: unknownRecordSchema,
    title: z.string().optional(),
    metadata: optionalUnknownRecordSchema,
    time: timeSpanSchema,
  }),
  z.object({
    status: z.literal("completed"),
    input: unknownRecordSchema,
    output: toolOutputSchema,
    title: z.string(),
    metadata: optionalUnknownRecordSchema,
    time: z.object({ start: z.number(), end: z.number() }),
    attachments: z.array(unknownRecordSchema).optional(),
  }),
  z.object({
    status: z.literal("error"),
    input: unknownRecordSchema,
    error: toolErrorSchema,
    metadata: optionalUnknownRecordSchema,
    time: z.object({ start: z.number(), end: z.number() }),
  }),
  z.object({
    status: z.literal("interrupted"),
    input: optionalUnknownRecordSchema,
    reason: z.string().optional(),
    time: z.object({ start: z.number(), end: z.number() }),
  }),
]);

const basePartShape = {
  id: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  time: z.union([timeSpanSchema, timeCreatedSchema]).optional(),
  metadata: optionalUnknownRecordSchema,
};

export const partSchema = z.discriminatedUnion("type", [
  z.object({
    ...basePartShape,
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    references: textReferencesSchema.optional(),
    command: commandBindingSchema.optional(),
    commandPrompt: z.string().min(1).max(32768).optional(),
  }).superRefine((part, ctx) => {
    try {
      validateReferenceMessage([part]);
      if (Boolean(part.command) !== (part.commandPrompt !== undefined)) throw new Error("Missing command snapshot");
    }
    catch { ctx.addIssue({ code: "custom", message: "Invalid text references", path: ["references"] }); }
  }),
  z.object({
    ...basePartShape,
    type: z.literal("reasoning"),
    text: z.string(),
    redacted: z.boolean().optional(),
  }),
  z.object({
    ...basePartShape,
    type: z.literal("file"),
    attachmentId: z.string().startsWith("att_"),
    mediaType: z.string(),
    filename: z.string(),
    byteLength: z.number().int().nonnegative(),
  }),
  z.object({
    ...basePartShape,
    type: z.literal("source"),
    sourceType: z.literal("url"),
    sourceId: z.string().optional(),
    url: z.string(),
    title: z.string().optional(),
  }),
  z.object({
    ...basePartShape,
    type: z.literal("tool"),
    toolCallId: z.string(),
    toolName: z.string(),
    state: toolStateSchema,
  }),
  z.object({
    ...basePartShape,
    type: z.literal("step-start"),
    stepIndex: z.number(),
  }),
  z.object({
    ...basePartShape,
    type: z.literal("step-finish"),
    stepIndex: z.number(),
    reason: finishReasonSchema,
    usage: tokenUsageSchema.optional(),
    cost: costUsageSchema.optional(),
  }),
  z.object({
    id: z.string(),
    conversationId: z.string(),
    messageId: z.string(),
    type: z.literal("retry"),
    attempt: z.number(),
    error: runtimeErrorSchema,
    time: timeCreatedSchema,
    metadata: optionalUnknownRecordSchema,
  }),
  z.object({
    ...basePartShape,
    type: z.literal("compaction"),
    auto: z.boolean(),
    summary: z.string().optional(),
  }),
  z.object({
    ...basePartShape,
    type: z.literal("diff"),
    diff: diffArtifactSchema,
    status: z.enum(["proposed", "applied", "rejected", "stale"]),
  }),
  z.object({
    ...basePartShape,
    type: z.literal("error"),
    error: runtimeErrorSchema,
  }),
]);

export const messageSchema = z.discriminatedUnion("role", [
  z
    .object({
      id: z.string(),
      conversationId: z.string(),
      role: z.literal("user"),
      activeTabContext: activeTabContextSchema.optional(),
      agentMode: agentModeSchema,
      model: z.object({ providerId: z.string(), modelId: z.string() }).optional(),
      summary: z.object({ title: z.string().optional(), body: z.string().optional() }).optional(),
      parts: z.array(partSchema),
      time: z.object({ created: z.number(), completed: z.number().optional() }),
      metadata: optionalUnknownRecordSchema,
    })
    .strict(),
  z
    .object({
      id: z.string(),
      conversationId: z.string(),
      role: z.literal("assistant"),
      runId: z.string(),
      parentId: z.string(),
      providerId: z.string(),
      modelId: z.string(),
      agentMode: agentModeSchema,
      status: z.union([
      z.object({ type: z.literal("running") }),
      z.object({
        type: z.literal("complete"),
        reason: finishReasonSchema.optional(),
      }),
      z.object({
        type: z.literal("incomplete"),
        reason: finishReasonSchema,
      }),
      z.object({ type: z.literal("requires-action"), reason: z.enum(["permission", "approval", "tool"]) }),
      z.object({ type: z.literal("error"), error: runtimeErrorSchema }),
      ]),
      usage: tokenUsageSchema.optional(),
      cost: costUsageSchema.optional(),
      finish: finishReasonSchema.optional(),
      error: runtimeErrorSchema.optional(),
      parts: z.array(partSchema),
      time: z.object({ created: z.number(), completed: z.number().optional() }),
      metadata: optionalUnknownRecordSchema,
    })
    .strict(),
  z.object({
    id: z.string(),
    conversationId: z.string(),
    role: z.literal("system"),
    scope: z.enum(["runtime", "profile", "request", "memory"]),
    parts: z.array(partSchema),
    time: z.object({ created: z.number(), completed: z.number().optional() }),
    metadata: optionalUnknownRecordSchema,
  }),
]);

export const permissionSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  runId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  status: z.enum(["pending", "approved", "denied", "cancelled"]),
  toolId: z.string(),
  title: z.string(),
  inputSummary: z.string().optional(),
  risk: z.object({
    level: z.enum(["low", "medium", "high", "critical"]),
    reversible: z.boolean(),
    sideEffects: z.array(
      z.enum([
        "none",
        "external_network",
        "runtime_state",
        "workbench_state",
        "business_read",
        "business_write",
        "destructive",
      ]),
    ),
  }),
  confirmation: z.object({
    level: z.enum(["standard", "strong"]),
    prompt: z.string().optional(),
  }),
  presentation: z
    .object({
      target: z
        .object({
          profileId: z.string().optional(),
          connectionName: z.string().optional(),
          driver: z.string().optional(),
          environment: z.string().optional(),
          database: z.string().optional(),
          schema: z.string().optional(),
          redisDbIndex: z.number().int().nonnegative().optional(),
        })
        .optional(),
      riskReasons: z.array(z.string()).optional(),
      sql: z
        .object({
          text: z.string(),
          analysisStatus: z.enum(["analyzed", "uncertain", "failed"]),
          statementClass: z.string().optional(),
          identifiedTargets: z.array(z.string()).optional(),
        })
        .optional(),
      keyValue: z
        .object({
          operation: z.enum(["create", "set", "rename", "set_ttl", "delete"]),
          key: z.string(),
          newKey: z.string().optional(),
          valueType: z.string().optional(),
          ttlMode: z.enum(["keep", "persist", "expire"]).optional(),
          ttlSeconds: z.number().int().positive().optional(),
        })
        .optional(),
      timeoutMs: z.number().int().positive().optional(),
      maxResultBytes: z.number().int().positive().optional(),
      outcomeWarnings: z.array(z.string()).optional(),
    })
    .optional(),
  adapter: z
    .object({
      aiSdkApprovalId: z.string().optional(),
      aiSdkToolCallId: z.string().optional(),
    })
    .optional(),
  decision: z
    .object({
      source: z.enum(["user", "system"]),
      reason: z.string().optional(),
      confirmationVerified: z.boolean().optional(),
      decidedAt: z.number(),
    })
    .optional(),
  createdAt: z.number(),
});

export const toolCallAuthorizationSnapshotSchema = z
  .object({
    version: z.literal("1"),
    risk: permissionSchema.shape.risk,
    presentation: z
      .object({
        target: z
          .object({
            profileId: z.string().optional(),
            connectionName: z.string().optional(),
            driver: z.string().optional(),
            environment: z.string().optional(),
            database: z.string().optional(),
            schema: z.string().optional(),
            redisDbIndex: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        sql: z
          .object({ identifiedTargets: z.array(z.string()).optional() })
          .strict()
          .optional(),
        keyValue: z
          .object({ key: z.string(), newKey: z.string().optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const contextCompactionTriggerSchema = z.enum([
  "auto_pre_turn",
  "auto_mid_turn",
  "manual",
  "provider_overflow",
  "model_switch",
]);

const nonnegativeTokenCountSchema = z.number().int().nonnegative();

export const contextBudgetSnapshotSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    contextWindow: z.number().finite().positive().optional(),
    reservedOutputTokens: nonnegativeTokenCountSchema,
    safetyMarginTokens: nonnegativeTokenCountSchema,
    systemPromptTokens: nonnegativeTokenCountSchema,
    toolSchemaTokens: nonnegativeTokenCountSchema,
    hardInputBudget: z.number().int().optional(),
    softTriggerTokens: z.number().int().optional(),
    targetTokens: z.number().int().optional(),
    rawHistoryTokens: nonnegativeTokenCountSchema,
    checkpointTokens: nonnegativeTokenCountSchema,
    safetyStateTokens: nonnegativeTokenCountSchema,
    estimatedInputTokens: nonnegativeTokenCountSchema,
    summaryMaxOutputTokens: nonnegativeTokenCountSchema.optional(),
    summaryRetryMaxOutputTokens: nonnegativeTokenCountSchema.optional(),
    summaryMaxInputTokens: nonnegativeTokenCountSchema.optional(),
    summaryRetryMaxInputTokens: nonnegativeTokenCountSchema.optional(),
  })
  .strict();

const contextUsageBreakdownSchema = z
  .object({
    rawTokens: nonnegativeTokenCountSchema,
    checkpointTokens: nonnegativeTokenCountSchema,
    safetyStateTokens: nonnegativeTokenCountSchema,
    systemPromptTokens: nonnegativeTokenCountSchema,
    toolSchemaTokens: nonnegativeTokenCountSchema,
  })
  .strict();

const nextTurnContextForecastSchema = z
  .object({
    conversationId: z.string().startsWith("conv_"),
    sourceHeadRunId: z.string().startsWith("run_"),
    sourceConversationRevision: z.number().int().nonnegative(),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    contextWindow: z.number().finite().positive().optional(),
    estimatedInputTokens: nonnegativeTokenCountSchema,
    view: z.enum(["raw", "checkpoint"]),
    checkpointId: z.string().startsWith("ckpt_").optional(),
    breakdown: contextUsageBreakdownSchema,
    estimatorVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    checkpointFormatVersion: z.string().min(1),
    reason: z.enum([
      "append",
      "checkpoint_created",
      "branch_changed",
      "model_changed",
      "prompt_policy_changed",
      "estimator_policy_changed",
    ]),
  })
  .strict()
  .superRefine((forecast, context) => {
    if (forecast.view === "checkpoint" && !forecast.checkpointId) {
      context.addIssue({
        code: "custom",
        path: ["checkpointId"],
        message: "A checkpoint forecast requires checkpointId",
      });
    }
    if (forecast.view === "raw" && forecast.checkpointId) {
      context.addIssue({
        code: "custom",
        path: ["checkpointId"],
        message: "A raw forecast cannot reference checkpointId",
      });
    }
  });

export const contextUsageSchema = z
  .object({
    id: z.string().startsWith("ctxuse_"),
    conversationId: z.string().startsWith("conv_"),
    runId: z.string().startsWith("run_"),
    requestIndex: z.number().int().nonnegative(),
    purpose: z.literal("checkpoint_summary").optional(),
    summaryInvocationCount: z.number().int().positive().optional(),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    contextWindow: z.number().finite().positive().optional(),
    estimatedInputTokens: nonnegativeTokenCountSchema,
    estimateSource: z.literal("estimate"),
    reservedOutputTokens: nonnegativeTokenCountSchema,
    view: z.enum(["raw", "checkpoint"]),
    checkpointId: z.string().startsWith("ckpt_").optional(),
    breakdown: contextUsageBreakdownSchema,
    providerObservation: z
      .object({
        source: z.literal("provider"),
        inputTokens: nonnegativeTokenCountSchema.optional(),
        outputTokens: nonnegativeTokenCountSchema.optional(),
        reasoningTokens: nonnegativeTokenCountSchema.optional(),
        cacheReadTokens: nonnegativeTokenCountSchema.optional(),
        cacheWriteTokens: nonnegativeTokenCountSchema.optional(),
        totalTokens: nonnegativeTokenCountSchema.optional(),
        observedInvocationCount: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    nextTurnForecast: nextTurnContextForecastSchema.optional(),
    estimatorVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    checkpointFormatVersion: z.string().min(1),
    time: timeCreatedSchema,
  })
  .strict();

const runtimeSafetyRiskSchema = z
  .object({
    level: z.enum(["unknown", "low", "medium", "high", "critical"]),
    reversible: z.union([z.boolean(), z.literal("unknown")]),
    sideEffects: z.array(
      z.enum([
        "unknown",
        "none",
        "external_network",
        "runtime_state",
        "workbench_state",
        "business_read",
        "business_write",
        "destructive",
      ]),
    ),
  })
  .strict();

const runtimeSafetyTargetSchema = z
  .object({
    kind: z.enum(["structured", "unknown"]),
    profileId: z.string().optional(),
    connectionName: z.string().optional(),
    driver: z.string().optional(),
    environment: z.string().optional(),
    database: z.string().optional(),
    schema: z.string().optional(),
    redisDbIndex: z.number().int().nonnegative().optional(),
    identifiedTargets: z.array(z.string()).optional(),
    key: z.string().optional(),
    newKey: z.string().optional(),
  })
  .strict();

export const runtimeSafetyStateSchema = z
  .object({
    version: z.string().min(1),
    conversationId: z.string().startsWith("conv_"),
    effects: z.array(
      z
        .object({
          toolCallId: z.string().startsWith("tool_"),
          runId: z.string().startsWith("run_"),
          operation: z.string().min(1),
          activeLineage: z.boolean(),
          risk: runtimeSafetyRiskSchema,
          target: runtimeSafetyTargetSchema,
          outcome: z.enum([
            "completed",
            "possibly_executed",
            "running",
            "waiting",
            "unknown",
          ]),
          certainty: z.enum(["confirmed", "uncertain"]),
        })
        .strict(),
    ),
    permissions: z.array(
      z
        .object({
          permissionId: z.string().startsWith("perm_"),
          toolCallId: z.string().startsWith("tool_"),
          runId: z.string().startsWith("run_"),
          status: z.enum(["pending", "approved", "denied", "cancelled"]),
          decisionSource: z.enum(["user", "system"]).optional(),
          confirmationVerified: z.boolean().optional(),
          nonTransferable: z.literal(true),
        })
        .strict(),
    ),
    continuations: z.array(
      z.object({
        toolCallId: z.string().startsWith("tool_"),
        runId: z.string().startsWith("run_"),
        prepareOperation: z.string().min(1),
        expiresAt: z.number().int().nonnegative(),
        requiresRevalidation: z.literal(true),
      }).strict(),
    ).optional(),
    hash: z.string().startsWith("sha256:"),
  })
  .strict();

export const contextCheckpointSchema = z
  .object({
    id: z.string().startsWith("ckpt_"),
    conversationId: z.string().startsWith("conv_"),
    coverageThroughRunId: z.string().startsWith("run_"),
    coverageCursor: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("run"),
        throughRunId: z.string().startsWith("run_"),
      }).strict(),
      z.object({
        kind: z.literal("sealed_step"),
        runId: z.string().startsWith("run_"),
        throughRequestIndex: z.number().int().nonnegative(),
        throughPartId: z.string().startsWith("part_"),
      }).strict(),
    ]).optional(),
    sourceHeadRunId: z.string().startsWith("run_"),
    sourceConversationRevision: z.number().int().nonnegative(),
    lineageHash: z.string().startsWith("sha256:"),
    sourceStateHash: z.string().startsWith("sha256:"),
    safetyStateHash: z.string().startsWith("sha256:"),
    parentCheckpointId: z.string().startsWith("ckpt_").optional(),
    trigger: contextCompactionTriggerSchema,
    formatVersion: z.string().min(1),
    compatibility: z
      .object({ kind: z.string().min(1), version: z.number().int().nonnegative() })
      .strict(),
    generatedBy: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).strict(),
    summary: z.string().min(1).max(DEFAULT_CONTEXT_COMPACTION_POLICY.summaryMaxChars),
    safetyStateVersion: z.string().min(1),
    budget: contextBudgetSnapshotSchema,
    usage: contextUsageSchema.optional(),
    time: timeCreatedSchema,
  })
  .strict();

export const contextCompactionActivitySchema = z
  .object({
    id: z.string().startsWith("cmp_"),
    conversationId: z.string().startsWith("conv_"),
    runId: z.string().startsWith("run_"),
    requestIndex: z.number().int().nonnegative(),
    boundaryStepIndex: z.number().int().nonnegative().optional(),
    attemptIndex: z.number().int().nonnegative(),
    trigger: contextCompactionTriggerSchema,
    status: z.enum(["preparing", "created", "failed", "recovered", "interrupted"]),
    sourceHeadRunId: z.string().startsWith("run_"),
    sourceConversationRevision: z.number().int().nonnegative(),
    coverageCursor: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("run"),
        throughRunId: z.string().startsWith("run_"),
      }).strict(),
      z.object({
        kind: z.literal("sealed_step"),
        runId: z.string().startsWith("run_"),
        throughRequestIndex: z.number().int().nonnegative(),
        throughPartId: z.string().startsWith("part_"),
      }).strict(),
    ]).optional(),
    checkpointId: z.string().startsWith("ckpt_").optional(),
    beforeEstimatedInputTokens: nonnegativeTokenCountSchema,
    afterEstimatedInputTokens: nonnegativeTokenCountSchema.optional(),
    startedAt: z.number().finite().nonnegative(),
    completedAt: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .superRefine((activity, context) => {
    if (activity.status === "preparing" && activity.completedAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A preparing compaction Activity cannot be completed",
      });
    }
    if (activity.status !== "preparing" && activity.completedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A terminal compaction Activity must have completedAt",
      });
    }
    if (
      activity.checkpointId !== undefined
      && activity.status !== "created"
      && activity.status !== "recovered"
    ) {
      context.addIssue({
        code: "custom",
        path: ["checkpointId"],
        message: "Only successful compaction Activities can reference a checkpoint",
      });
    }
    if (
      activity.afterEstimatedInputTokens !== undefined
      && activity.status !== "created"
      && activity.status !== "recovered"
    ) {
      context.addIssue({
        code: "custom",
        path: ["afterEstimatedInputTokens"],
        message: "Only successful compaction Activities can expose an after estimate",
      });
    }
  });

export const contextPlanSchema = z
  .object({
    id: z.string().startsWith("ctxplan_"),
    conversationId: z.string().startsWith("conv_"),
    runId: z.string().startsWith("run_"),
    requestIndex: z.number().int().nonnegative(),
    sourceHeadRunId: z.string().startsWith("run_"),
    sourceConversationRevision: z.number().int().nonnegative(),
    trigger: contextCompactionTriggerSchema,
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    view: z.enum(["raw", "checkpoint"]),
    reason: z.enum([
      "context_window_unavailable",
      "raw_within_budget",
      "raw_compaction_blocked",
      "checkpoint_selected",
      "compaction_required",
    ]),
    checkpointId: z.string().startsWith("ckpt_").optional(),
    lineageRunIds: z.array(z.string().startsWith("run_")),
    rawRunIds: z.array(z.string().startsWith("run_")),
    rawRange: z
      .object({
        fromRunId: z.string().startsWith("run_"),
        throughRunId: z.string().startsWith("run_"),
      })
      .strict()
      .optional(),
    eligibleCoverageThroughRunId: z.string().startsWith("run_").optional(),
    eligibleCoverageCursor: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("run"),
        throughRunId: z.string().startsWith("run_"),
      }).strict(),
      z.object({
        kind: z.literal("sealed_step"),
        runId: z.string().startsWith("run_"),
        throughRequestIndex: z.number().int().nonnegative(),
        throughPartId: z.string().startsWith("part_"),
      }).strict(),
    ]).optional(),
    checkpointRejections: z.array(
      z.object({
        checkpointId: z.string().startsWith("ckpt_"),
        reason: z.enum([
          "unsupported_format",
          "unsupported_compatibility",
          "dangling_parent",
          "lineage_hash_mismatch",
          "coverage_not_active_ancestor",
          "unsafe_coverage_boundary",
          "raw_tail_too_short",
          "target_budget_exceeded",
        ]),
      }).strict(),
    ).optional(),
    safetyState: runtimeSafetyStateSchema,
    budget: contextBudgetSnapshotSchema,
    requestHash: z.string().startsWith("sha256:"),
    viewHash: z.string().startsWith("sha256:"),
    time: timeCreatedSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (
      plan.reason === "compaction_required"
      && !plan.eligibleCoverageCursor
      && !plan.eligibleCoverageThroughRunId
    ) {
      context.addIssue({
        code: "custom",
        path: ["eligibleCoverageThroughRunId"],
        message: "A compaction-required plan must name an eligible coverage Run",
      });
    }
  });

export const eventSchema = z.object({
  id: z.string(),
  type: z.string(),
  properties: unknownRecordSchema,
  time: z.number(),
});

const traceEventBaseSchema = z.object({
  id: z.string(),
  conversationId: z.string().optional(),
  runId: z.string().optional(),
  type: z.enum([
    "request.received",
    "model.resolved",
    "prompt.assembled",
    "tool.registry.resolved",
    "permission.decided",
    "tool.executed",
    "stream.started",
    "stream.finished",
    "stream.failed",
    "context.compaction.preparing",
    "context.compaction.failed",
    "context.overflow.retrying",
    "context.overflow.recovered",
  ]),
  level: z.enum(["debug", "info", "warn", "error"]),
  time: z.number(),
  payload: unknownRecordSchema,
});

const contextOverflowRecoveredTracePayloadSchema = z
  .object({
    error: z
      .object({
        name: z.string().min(1),
        data: z
          .object({
            message: z.string(),
            statusCode: z.number().finite().optional(),
            isRetryable: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    requestIndex: z.number().int().nonnegative(),
    sourceHeadRunId: z.string().startsWith("run_"),
    sourceConversationRevision: z.number().int().nonnegative(),
    checkpointId: z.string().startsWith("ckpt_"),
    beforeEstimatedInputTokens: nonnegativeTokenCountSchema,
    afterEstimatedInputTokens: nonnegativeTokenCountSchema,
  })
  .strict();

const contextCompactionLifecycleBasePayloadSchema = z
  .object({
    trigger: contextCompactionTriggerSchema,
    requestIndex: z.number().int().nonnegative(),
    sourceHeadRunId: z.string().startsWith("run_"),
    sourceConversationRevision: z.number().int().nonnegative(),
    beforeEstimatedInputTokens: nonnegativeTokenCountSchema,
    summaryMaxOutputTokens: nonnegativeTokenCountSchema.optional(),
    summaryRetryMaxOutputTokens: nonnegativeTokenCountSchema.optional(),
  })
  .strict();

const contextCompactionPreparingTracePayloadSchema =
  contextCompactionLifecycleBasePayloadSchema;

const contextCompactionFailedTracePayloadSchema = z
  .object({
    trigger: contextCompactionTriggerSchema,
    requestIndex: z.number().int().nonnegative(),
    sourceHeadRunId: z.string().startsWith("run_"),
    sourceConversationRevision: z.number().int().nonnegative(),
    beforeEstimatedInputTokens: nonnegativeTokenCountSchema,
    summaryMaxOutputTokens: nonnegativeTokenCountSchema.optional(),
    summaryRetryMaxOutputTokens: nonnegativeTokenCountSchema.optional(),
    errorName: z.string().min(1),
    finishReason: z.string().min(1).optional(),
    inputTokens: nonnegativeTokenCountSchema.optional(),
    outputTokens: nonnegativeTokenCountSchema.optional(),
    textTokens: nonnegativeTokenCountSchema.optional(),
    reasoningTokens: nonnegativeTokenCountSchema.optional(),
    summaryInvocationCount: z.number().int().positive().optional(),
    summaryReservedOutputTokens: nonnegativeTokenCountSchema.optional(),
  })
  .strict();

export const traceEventSchema = traceEventBaseSchema.superRefine((trace, context) => {
  const payloadSchema = trace.type === "context.overflow.recovered"
    || trace.type === "context.overflow.retrying"
    ? contextOverflowRecoveredTracePayloadSchema
    : trace.type === "context.compaction.preparing"
      ? contextCompactionPreparingTracePayloadSchema
      : trace.type === "context.compaction.failed"
        ? contextCompactionFailedTracePayloadSchema
        : undefined;
  if (!payloadSchema) return;
  const parsed = payloadSchema.safeParse(trace.payload);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({
      ...issue,
      path: ["payload", ...issue.path],
    });
  }
});
