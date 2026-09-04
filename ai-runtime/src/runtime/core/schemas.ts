import { z } from "zod";

const unknownRecordSchema = z.record(z.string(), z.unknown());
const optionalUnknownRecordSchema = unknownRecordSchema.optional();

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
  .strict();

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

export const eventSchema = z.object({
  id: z.string(),
  type: z.string(),
  properties: unknownRecordSchema,
  time: z.number(),
});

export const traceEventSchema = z.object({
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
  ]),
  level: z.enum(["debug", "info", "warn", "error"]),
  time: z.number(),
  payload: unknownRecordSchema,
});
