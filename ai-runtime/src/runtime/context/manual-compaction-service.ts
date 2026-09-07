import { randomUUID } from "node:crypto";
import type { RuntimeDatabase } from "../../storage/runtime-database";
import { createRuntimeId } from "../core/ids";
import type { ConversationId, RunId } from "../core/types";
import type { RuntimeSqliteStore } from "../store/sqlite-store";
import type { RuntimeResolvedLanguageModel } from "../runners/text-runner";
import {
  ContextCompactionService,
  readContextPlannerSnapshot,
} from "./compaction-service";
import { ModelContextManager } from "./model-context-manager";
import { computeContextPlanRequestHash, planContextWindow } from "./planner";
import { DEFAULT_CONTEXT_COMPACTION_POLICY } from "./policy";
import { CONTEXT_PREPARATION_CLAIM_TTL_MS } from "./types";
import {
  resolveAgentExecutionPolicy,
  type ResolvedAgentExecutionPolicy,
} from "../agents/agent-resolver";

export interface ManualCompactionOperation {
  id: string;
  conversationId: ConversationId;
  runId: RunId;
  requestIndex: number;
  requestKey: string;
  providerId: string;
  modelId: string;
  status: "preparing" | "created" | "not_needed" | "failed" | "interrupted";
  createdAt: number;
  error?: string;
}
export class ManualCompactionError extends Error {
  constructor(
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
  }
}
export class ManualCompactionService {
  private controllers = new Map<string, AbortController>();
  private tasks = new Map<string, Promise<void>>();
  constructor(
    private readonly deps: {
      db: RuntimeDatabase;
      store: RuntimeSqliteStore;
      compactor: ContextCompactionService;
      manager: ModelContextManager;
      resolveModel: (input: {
        providerId: string;
        modelId: string;
      }) => RuntimeResolvedLanguageModel;
      resolvePolicy?: (
        runId: RunId,
        resolved: RuntimeResolvedLanguageModel,
      ) => ResolvedAgentExecutionPolicy;
    },
  ) {}

  get(conversationId: string, id?: string): ManualCompactionOperation | null {
    const row = id
      ? this.deps.db
          .query(
            "SELECT payload_json FROM runtime_manual_compactions WHERE conversation_id=? AND id=?",
          )
          .get(conversationId, id)
      : this.deps.db
          .query(
            "SELECT payload_json FROM runtime_manual_compactions WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
          )
          .get(conversationId);
    return row
      ? JSON.parse((row as { payload_json: string }).payload_json)
      : null;
  }

  start(
    conversationId: ConversationId,
    input: { requestKey: string; providerId: string; modelId: string },
  ): ManualCompactionOperation {
    const existing = this.deps.db
      .query(
        "SELECT payload_json FROM runtime_manual_compactions WHERE conversation_id=? AND request_key=?",
      )
      .get(conversationId, input.requestKey) as { payload_json: string } | null;
    if (existing) {
      const operation: ManualCompactionOperation = JSON.parse(
        existing.payload_json,
      );
      if (
        operation.providerId !== input.providerId ||
        operation.modelId !== input.modelId
      )
        throw new ManualCompactionError("重复请求与原压缩参数不同");
      return operation;
    }
    const resolved = this.deps.resolveModel(input);
    if (!resolved.runtimeContext.provider.contextLength)
      throw new ManualCompactionError("当前模型缺少上下文窗口信息", 422);
    const operation = this.deps.db.transaction(
      (): ManualCompactionOperation => {
        const conversation = this.deps.store.getConversation(conversationId);
        if (!conversation) throw new ManualCompactionError("会话不存在", 404);
        if (!conversation.activeHeadRunId)
          throw new ManualCompactionError("空会话没有可压缩的上下文", 422);
        if (
          conversation.time.compacting !== undefined ||
          conversation.status.type !== "idle"
        )
          throw new ManualCompactionError("请等待当前回复或压缩结束");
        const runId = conversation.activeHeadRunId;
        const run = this.deps.store.getRun(runId);
        if (
          !run ||
          !["completed", "failed", "interrupted"].includes(run.status)
        )
          throw new ManualCompactionError("当前会话尚未结束运行");
        // The head is terminal: reserve a fresh slot beyond every existing context request.
        // This operation has its own durable ID and never overwrites a Provider request.
        const previous = this.deps.db
          .query(
            "SELECT MAX(request_index) AS n FROM runtime_manual_compactions WHERE run_id=?",
          )
          .get(runId) as { n: number | null };
        const requestIndex =
          1 +
          Math.max(
            -1,
            previous.n ?? -1,
            ...this.deps.store.listTraces(runId).map((trace) => {
              const value = trace.payload?.requestIndex;
              return typeof value === "number" &&
                Number.isSafeInteger(value) &&
                value >= 0
                ? value
                : -1;
            }),
            ...(run.assistantMessageId
              ? (this.deps.store
                  .getMessage(run.assistantMessageId)
                  ?.parts.flatMap((part) =>
                    part.type === "step-start" ? [part.stepIndex] : [],
                  ) ?? [])
              : []),
            ...this.deps.store
              .listContextPlansByRun(runId)
              .map((p) => p.requestIndex),
            ...this.deps.store
              .listContextUsagesByRun(runId)
              .map((p) => p.requestIndex),
            ...this.deps.store
              .listContextCompactionActivitiesByRun(runId)
              .map((p) => p.requestIndex),
          );
        const next: ManualCompactionOperation = {
          id: randomUUID(),
          conversationId,
          runId,
          requestIndex,
          ...input,
          status: "preparing",
          createdAt: Date.now(),
        };
        this.deps.db
          .query(
            "INSERT INTO runtime_manual_compactions(id,conversation_id,request_key,run_id,request_index,status,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            next.id,
            conversationId,
            input.requestKey,
            runId,
            requestIndex,
            next.status,
            JSON.stringify(next),
            next.createdAt,
          );
        this.deps.store.saveConversation({
          ...conversation,
          time: { ...conversation.time, compacting: next.createdAt },
        });
        return next;
      },
    )();
    const controller = new AbortController();
    this.controllers.set(operation.id, controller);
    const task = this.execute(operation, resolved, controller.signal)
      .catch((error) => {
        console.error("[manual-compaction] operation failed", error);
        this.finish(
          operation,
          controller.signal.aborted ? "interrupted" : "failed",
          "上下文压缩失败，请重试",
        );
      })
      .finally(() => {
        this.controllers.delete(operation.id);
        this.tasks.delete(operation.id);
      });
    this.tasks.set(operation.id, task);
    return operation;
  }

  cancel(conversationId: string, id: string): ManualCompactionOperation {
    const operation = this.get(conversationId, id);
    if (!operation) throw new ManualCompactionError("压缩操作不存在", 404);
    if (operation.status === "preparing") {
      this.controllers.get(id)?.abort();
      const claim = this.deps.store.getContextPreparationClaim(
        operation.runId,
        operation.requestIndex,
      );
      if (claim) this.deps.store.releaseContextPreparationClaim(claim);
      this.interruptActivities(operation);
      this.finish(operation, "interrupted");
    }
    return this.get(conversationId, id)!;
  }

  repair(): void {
    const rows = this.deps.db
      .query(
        "SELECT payload_json FROM runtime_manual_compactions WHERE status='preparing'",
      )
      .all() as { payload_json: string }[];
    for (const row of rows) {
      const operation: ManualCompactionOperation = JSON.parse(row.payload_json);
      const activities = this.deps.store
        .listContextCompactionActivitiesByRun(operation.runId)
        .filter((a) => a.requestIndex === operation.requestIndex);
      const committed = activities.find((a) => a.status === "created");
      const claim = this.deps.store.getContextPreparationClaim(
        operation.runId,
        operation.requestIndex,
      );
      if (claim) this.deps.store.releaseContextPreparationClaim(claim);
      this.finish(operation, committed ? "created" : "interrupted");
      for (const activity of activities.filter(
        (a) => a.status === "preparing",
      )) {
        this.deps.store.finishContextCompactionActivity({
          activityId: activity.id,
          status: "interrupted",
          completedAt: Date.now(),
          eventId: createRuntimeId("evt"),
        });
      }
    }
  }
  async stop(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.tasks.values());
  }

  private interruptActivities(operation: ManualCompactionOperation): void {
    for (const activity of this.deps.store.listContextCompactionActivitiesByRun(
      operation.runId,
    )) {
      if (
        activity.requestIndex === operation.requestIndex &&
        activity.status === "preparing"
      ) {
        this.deps.store.finishContextCompactionActivity({
          activityId: activity.id,
          status: "interrupted",
          completedAt: Date.now(),
          eventId: createRuntimeId("evt"),
        });
      }
    }
  }

  private finish(
    operation: ManualCompactionOperation,
    status: ManualCompactionOperation["status"],
    error?: string,
  ): void {
    this.deps.db.transaction(() => {
      const current = this.get(operation.conversationId, operation.id);
      if (current?.status !== "preparing") return;
      const next = { ...current, status, ...(error ? { error } : {}) };
      this.deps.db
        .query(
          "UPDATE runtime_manual_compactions SET status=?,payload_json=? WHERE id=? AND status='preparing'",
        )
        .run(status, JSON.stringify(next), operation.id);
      const conversation = this.deps.store.getConversation(
        operation.conversationId,
      );
      if (conversation?.time.compacting === operation.createdAt) {
        const { compacting: _, ...time } = conversation.time;
        this.deps.store.saveConversation({ ...conversation, time });
      }
    })();
  }

  private async execute(
    operation: ManualCompactionOperation,
    resolved: RuntimeResolvedLanguageModel,
    signal: AbortSignal,
  ): Promise<void> {
    const { store, compactor, manager } = this.deps;
    const snapshot = readContextPlannerSnapshot(
      store,
      operation.conversationId,
    );
    const provider = resolved.runtimeContext.provider;
    const policy =
      this.deps.resolvePolicy?.(operation.runId, resolved) ??
      resolveAgentExecutionPolicy({ runId: operation.runId, provider });
    const input = {
      conversationId: operation.conversationId,
      runId: operation.runId,
      requestIndex: operation.requestIndex,
      providerId: operation.providerId,
      modelId: operation.modelId,
      model: resolved.languageModel,
      contextWindow: provider.contextLength,
      modelOutputLimit: provider.outputLength,
      reservedOutputTokens:
        policy.limits.maxOutputTokens ?? provider.outputLength ?? 4096,
      systemPrompt: policy.prompt.system,
      toolSchemas: policy.toolResolution.snapshot,
      trigger: "manual" as const,
      policy: DEFAULT_CONTEXT_COMPACTION_POLICY,
      abortSignal: signal,
      timeoutMs: 120000,
    };
    // Summary generation uses only user history and the existing safety projection.
    const plan = planContextWindow({
      ...input,
      snapshot,
      planId: createRuntimeId("ctxplan"),
      createdAt: Date.now(),
    });
    if (plan.reason !== "compaction_required") {
      this.finish(operation, "not_needed");
      return;
    }
    const claim = store.claimContextPreparation({
      runId: operation.runId,
      requestIndex: operation.requestIndex,
      requestHash: computeContextPlanRequestHash(input),
      ownerId: operation.id,
      ttlMs: CONTEXT_PREPARATION_CLAIM_TTL_MS,
    });
    if (claim.status !== "acquired")
      throw new ManualCompactionError("压缩操作已被占用");
    try {
      const result = await compactor.compact({
        ...input,
        preparationClaim: claim.claim,
        expectedHeadRunId: operation.runId,
        expectedConversationRevision: snapshot.conversation.revision,
      });
      signal.throwIfAborted();
      if (result.status === "created") {
        const forecast = manager.forecastNextTurn({
          ...input,
          requestIndex: operation.requestIndex + 1,
          reason: "checkpoint_created",
        });
        store.saveContextUsage({
          id: createRuntimeId("ctxuse"),
          conversationId: operation.conversationId,
          runId: operation.runId,
          requestIndex: operation.requestIndex,
          providerId: operation.providerId,
          modelId: operation.modelId,
          contextWindow: forecast.contextWindow,
          estimatedInputTokens: forecast.estimatedInputTokens,
          estimateSource: "estimate",
          reservedOutputTokens: input.reservedOutputTokens,
          view: forecast.view,
          checkpointId: forecast.checkpointId,
          breakdown: forecast.breakdown,
          nextTurnForecast: forecast,
          estimatorVersion: forecast.estimatorVersion,
          policyVersion: forecast.policyVersion,
          checkpointFormatVersion: forecast.checkpointFormatVersion,
          time: { created: Date.now() },
        });
      }
      this.finish(
        operation,
        result.status === "created"
          ? "created"
          : result.status === "stale"
            ? "interrupted"
            : "not_needed",
      );
    } finally {
      store.releaseContextPreparationClaim(claim.claim);
    }
  }
}
