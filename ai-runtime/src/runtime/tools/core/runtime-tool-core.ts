import { createRuntimeId } from "../../core/ids";
import type {
  ConversationId,
  Event,
  MessageId,
  PartId,
  Permission,
  RunId,
  ToolCall,
  ToolCallId,
  TraceEvent,
} from "../../core/types";
import type {
  AnyRuntimeToolDefinition,
  BackendToolExecutionIdentity,
  BackendToolExecutionContext,
  PreparedToolInvocation,
  PreparedPlanLinkMetadata,
  ResolvedToolRisk,
  RuntimePolicyDecision,
  RuntimeToolError,
  RuntimeToolResult,
  ToolExecutionOutput,
  ToolExecutionOutcome,
  ToolRiskLevel,
  ToolSideEffect,
} from "../contracts";
import { TOOL_SIDE_EFFECTS } from "../contracts";
import { DEFAULT_NETWORK_ACCESS_SCOPE } from "../../../settings/defaults";
import type { RuntimeToolRegistry } from "../kernel";
import type { RunToolSnapshot } from "../resolution";
import {
  PreparedToolInvocationRegistry,
  PreparedToolInvocationRegistryError,
} from "./prepared-tool-invocation-registry";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_MAX_TOOL_CALLS = 32;
const RISK_RANK: Record<ToolRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};
const SENSITIVE_KEY = /(?:password|passwd|secret|token|authorization|api[_-]?key)/i;

export interface RuntimeToolCoreStore {
  saveToolCall(toolCall: ToolCall): void;
  getToolCall(id: ToolCallId): ToolCall | null;
  listToolCallsByRun(runId: RunId): ToolCall[];
  getPermissionByToolCallId(toolCallId: ToolCallId): Permission | null;
  commitToolPermissionRequest(input: {
    toolCall: ToolCall;
    permission: Permission;
    requestedAt: number;
    eventIds: {
      tool: Event["id"];
      permission: Event["id"];
      run: Event["id"];
      conversation: Event["id"];
    };
  }): unknown;
  appendEvent(event: Event): void;
  appendTrace(trace: TraceEvent): void;
}

export interface BackendToolExecutor {
  prepare?(
    operation: string,
    input: unknown,
    identity: BackendToolExecutionIdentity,
    signal: AbortSignal,
  ): Promise<PreparedToolInvocation>;
  execute(
    operation: string,
    input: unknown,
    signal: AbortSignal,
    identity?: BackendToolExecutionIdentity,
  ): Promise<ToolExecutionOutput<unknown>>;
  cleanupRun?(runId: RunId): Promise<void>;
}

export interface RuntimeToolPolicyContext {
  tool: AnyRuntimeToolDefinition;
  risk: ResolvedToolRisk;
  snapshot: RunToolSnapshot;
}

export type RuntimeToolPolicyEvaluator = (
  context: RuntimeToolPolicyContext,
) => RuntimePolicyDecision;

export interface RuntimeToolCoreOptions {
  registry: RuntimeToolRegistry;
  store: RuntimeToolCoreStore;
  backendExecutor?: BackendToolExecutor;
  evaluatePolicy?: RuntimeToolPolicyEvaluator;
  maxToolCallsPerRun?: number;
  defaultTimeoutMs?: number;
  defaultMaxResultBytes?: number;
  now?: () => number;
  preparedInvocations?: PreparedToolInvocationRegistry;
}

export interface DispatchRuntimeToolInput {
  conversationId: ConversationId;
  runId: RunId;
  messageId: MessageId;
  partId?: PartId;
  toolCallId?: ToolCallId;
  providerName: string;
  input: unknown;
  snapshot: RunToolSnapshot;
  abortSignal?: AbortSignal;
}

export type RuntimeToolAuthorization =
  | { decision: "allow"; risk: ResolvedToolRisk }
  | { decision: "ask"; risk: ResolvedToolRisk; permission: Permission }
  | { decision: "deny"; risk: ResolvedToolRisk; reason: string }
  | { decision: "error"; error: RuntimeToolError };

export class RuntimeToolExecutionError extends Error implements RuntimeToolError {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly outcome: ToolExecutionOutcome,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuntimeToolExecutionError";
  }
}

export class RuntimeToolCore {
  readonly #registry: RuntimeToolRegistry;
  readonly #store: RuntimeToolCoreStore;
  readonly #backendExecutor?: BackendToolExecutor;
  readonly #evaluatePolicy: RuntimeToolPolicyEvaluator;
  readonly #maxToolCallsPerRun: number;
  readonly #defaultTimeoutMs: number;
  readonly #defaultMaxResultBytes: number;
  readonly #now: () => number;
  readonly #preparedInvocations: PreparedToolInvocationRegistry;
  readonly #inFlightByRun = new Map<RunId, number>();

  constructor(options: RuntimeToolCoreOptions) {
    this.#registry = options.registry;
    this.#store = options.store;
    this.#backendExecutor = options.backendExecutor;
    this.#evaluatePolicy = options.evaluatePolicy ?? defaultPolicy;
    this.#maxToolCallsPerRun = positiveInteger(
      options.maxToolCallsPerRun ?? DEFAULT_MAX_TOOL_CALLS,
      "maxToolCallsPerRun",
    );
    this.#defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    this.#defaultMaxResultBytes = positiveInteger(
      options.defaultMaxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
      "defaultMaxResultBytes",
    );
    this.#now = options.now ?? Date.now;
    this.#preparedInvocations =
      options.preparedInvocations ?? new PreparedToolInvocationRegistry(this.#now);
  }

  async dispatch<TData = unknown>(
    invocation: DispatchRuntimeToolInput,
  ): Promise<RuntimeToolResult<TData>> {
    const toolCallId = invocation.toolCallId ?? createRuntimeId("tool");
    let normalizedInput: Record<string, unknown> = {};
    let toolId: string | null = null;
    let started: number | undefined;
    let reserved = false;
    let permission: Permission | null = null;
    let created = this.#now();

    try {
      const tool = this.#resolveActiveTool(invocation);
      toolId = tool.id;
      normalizedInput = parseObjectInput(tool, invocation.input);
      const existingToolCall = this.#store.getToolCall(toolCallId);
      if (!existingToolCall) {
        this.#reserveToolCall(invocation.runId);
        reserved = true;
      } else {
        assertExistingToolCall(existingToolCall, invocation, tool.id, normalizedInput);
        created = existingToolCall.time.created;
        if (
          (existingToolCall.state === "completed" ||
            existingToolCall.state === "error") &&
          existingToolCall.result
        ) {
          return existingToolCall.result as RuntimeToolResult<TData>;
        }
        if (existingToolCall.state !== "waiting_for_permission") {
          throw new RuntimeToolExecutionError(
            "TOOL_CALL_NOT_EXECUTABLE",
            "Existing ToolCall is not available for permission continuation.",
            false,
            "unknown",
          );
        }
      }
      if (invocation.abortSignal?.aborted) {
        throw new RuntimeToolExecutionError(
          "TOOL_EXECUTION_ABORTED",
          "Tool execution was aborted.",
          false,
          "not_started",
        );
      }

      const risk = await this.#resolveRisk(
        tool,
        normalizedInput,
        invocation,
        toolCallId,
        existingToolCall === null,
      );
      assertWithinSnapshotCeiling(risk, invocation.snapshot);
      permission = this.#store.getPermissionByToolCallId(toolCallId);
      if (permission) {
        assertPermissionBinding(permission, invocation, tool.id, toolCallId);
        if (permission.status === "pending") {
          if (reserved) {
            this.#releaseToolCall(invocation.runId);
            reserved = false;
          }
          return permissionRequiredResult() as RuntimeToolResult<TData>;
        }
        if (permission.status !== "approved") {
          throw new RuntimeToolExecutionError(
            "TOOL_PERMISSION_DENIED",
            permission.decision?.reason ?? "This tool call was not approved.",
            false,
            "not_started",
          );
        }
      } else {
        const decision = this.#evaluatePolicy({ tool, risk, snapshot: invocation.snapshot });
        if (decision === "ask") {
          const description = await this.#describePermission(
            tool,
            normalizedInput,
            risk,
            invocation,
            toolCallId,
          );
          this.#requestPermission(
            toolCallId,
            invocation,
            tool.id,
            tool.title,
            normalizedInput,
            risk,
            created,
            description,
            this.#preparedPlanMetadata(tool, toolCallId),
          );
          this.#releaseToolCall(invocation.runId);
          reserved = false;
          return permissionRequiredResult() as RuntimeToolResult<TData>;
        }
        if (decision === "deny") {
          throw new RuntimeToolExecutionError(
            "TOOL_PERMISSION_DENIED",
            "This tool call is denied by Runtime policy.",
            false,
            "not_started",
          );
        }
      }

      started = this.#now();
      this.#persist(
        toolCallId,
        invocation,
        toolId,
        normalizedInput,
        "running",
        created,
        started,
        undefined,
        undefined,
        permission?.id,
      );

      const output = await this.#execute(
        tool,
        normalizedInput,
        invocation,
        toolCallId,
      );

      const safeOutput = redactSecrets({
        summary: output.summary,
        data: output.data,
        ...(output.warnings ? { warnings: output.warnings } : {}),
      }) as {
        summary: string;
        data: TData;
        warnings?: string[];
      };
      const maxResultBytes = tool.limits?.maxResultBytes ?? this.#defaultMaxResultBytes;
      if (Buffer.byteLength(JSON.stringify(safeOutput)) > maxResultBytes) {
        throw new RuntimeToolExecutionError(
          "TOOL_RESULT_TOO_LARGE",
          "Tool result exceeds the configured size limit.",
          false,
          "unknown",
        );
      }

      const result: RuntimeToolResult<TData> = { ok: true, ...safeOutput };
      const completed = this.#now();
      try {
        this.#persist(
          toolCallId,
          invocation,
          toolId,
          normalizedInput,
          "completed",
          created,
          started,
          completed,
          result,
          permission?.id,
        );
        this.#appendTrace(invocation, toolId, "info", completed, {
          ok: true,
          durationMs: completed - started,
        });
      } finally {
        if (reserved) {
          this.#releaseToolCall(invocation.runId);
          reserved = false;
        }
      }
      return result;
    } catch (error) {
      const normalized = normalizeError(error);
      const result: RuntimeToolResult<TData> = { ok: false, error: normalized };
      const completed = this.#now();
      try {
        if (toolId !== null) {
          this.#persist(
            toolCallId,
            invocation,
            toolId,
            normalizedInput,
            "error",
            created,
            started,
            completed,
            result,
            permission?.id,
          );
          this.#appendTrace(invocation, toolId, "warn", completed, {
            ok: false,
            errorCode: normalized.code,
            outcome: normalized.outcome,
            durationMs: started === undefined ? 0 : completed - started,
          });
        }
      } finally {
        if (reserved) this.#releaseToolCall(invocation.runId);
      }
      return result;
    }
  }

  async authorize(
    invocation: DispatchRuntimeToolInput,
  ): Promise<RuntimeToolAuthorization> {
    const toolCallId = invocation.toolCallId ?? createRuntimeId("tool");
    let toolId = this.#registry.getCanonicalId(invocation.providerName);
    let normalizedInput: Record<string, unknown> = {};
    let created = this.#now();
    let reserved = false;

    try {
      const tool = this.#resolveActiveTool(invocation);
      toolId = tool.id;
      normalizedInput = parseObjectInput(tool, invocation.input);
      const existingToolCall = this.#store.getToolCall(toolCallId);
      if (existingToolCall) {
        assertExistingToolCall(existingToolCall, invocation, tool.id, normalizedInput);
        created = existingToolCall.time.created;
        if (
          existingToolCall.state === "error" &&
          existingToolCall.result &&
          !existingToolCall.result.ok
        ) {
          return {
            decision: "error",
            error: existingToolCall.result.error,
          };
        }
      } else {
        this.#reserveToolCall(invocation.runId);
        reserved = true;
      }

      const risk = await this.#resolveRisk(
        tool,
        normalizedInput,
        invocation,
        toolCallId,
        existingToolCall === null,
      );
      assertWithinSnapshotCeiling(risk, invocation.snapshot);
      const existingPermission = this.#store.getPermissionByToolCallId(toolCallId);
      if (existingPermission) {
        assertPermissionBinding(existingPermission, invocation, tool.id, toolCallId);
        if (
          existingPermission.status === "denied" ||
          existingPermission.status === "cancelled"
        ) {
          return {
            decision: "deny",
            risk,
            reason:
              existingPermission.decision?.reason ?? "Tool call was not approved.",
          };
        }
        return { decision: "ask", risk, permission: existingPermission };
      }

      const decision = this.#evaluatePolicy({ tool, risk, snapshot: invocation.snapshot });
      if (decision === "allow") {
        return { decision, risk };
      }
      if (decision === "deny") {
        return {
          decision: "deny",
          risk,
          reason: "This tool call is denied by Runtime policy.",
        };
      }

      const description = await this.#describePermission(
        tool,
        normalizedInput,
        risk,
        invocation,
        toolCallId,
      );
      const permission = this.#requestPermission(
        toolCallId,
        invocation,
        tool.id,
        tool.title,
        normalizedInput,
        risk,
        this.#now(),
        description,
        this.#preparedPlanMetadata(tool, toolCallId),
      );
      return { decision, risk, permission };
    } catch (error) {
      const normalized = normalizeError(error);
      const completed = this.#now();
      const result: RuntimeToolResult<never> = { ok: false, error: normalized };
      if (toolId !== null) {
        this.#persist(
          toolCallId,
          invocation,
          toolId,
          normalizedInput,
          "error",
          created,
          undefined,
          completed,
          result,
        );
        this.#appendTrace(invocation, toolId, "warn", completed, {
          ok: false,
          phase: "authorization",
          errorCode: normalized.code,
          outcome: normalized.outcome,
          durationMs: 0,
        });
        this.#preparedInvocations.forget(toolCallId);
      }
      return { decision: "error", error: normalized };
    } finally {
      if (reserved) {
        this.#releaseToolCall(invocation.runId);
      }
    }
  }

  #resolveActiveTool(invocation: DispatchRuntimeToolInput): AnyRuntimeToolDefinition {
    if (
      invocation.snapshot.runId !== invocation.runId ||
      !isDeeplyFrozenSnapshot(invocation.snapshot)
    ) {
      throw new RuntimeToolExecutionError(
        "TOOL_SNAPSHOT_INVALID",
        "Tool snapshot does not belong to this run or is mutable.",
        false,
        "not_started",
      );
    }
    const active = invocation.snapshot.activeTools.find(
      (item) => item.providerName === invocation.providerName,
    );
    if (!active) {
      throw new RuntimeToolExecutionError(
        "TOOL_NOT_ACTIVE",
        "Provider tool is not active in this run.",
        false,
        "not_started",
      );
    }
    if (
      this.#registry.getCanonicalId(invocation.providerName) !== active.canonicalId
    ) {
      throw new RuntimeToolExecutionError(
        "TOOL_IDENTITY_INVALID",
        "Provider tool identity does not match the Runtime registry.",
        false,
        "not_started",
      );
    }
    return this.#registry.requireTool(active.canonicalId);
  }

  #reserveToolCall(runId: RunId): void {
    const inFlight = this.#inFlightByRun.get(runId) ?? 0;
    if (
      this.#store.listToolCallsByRun(runId).length + inFlight >=
      this.#maxToolCallsPerRun
    ) {
      throw new RuntimeToolExecutionError(
        "TOOL_CALL_LIMIT_EXCEEDED",
        "Run tool-call limit has been reached.",
        false,
        "not_started",
      );
    }
    this.#inFlightByRun.set(runId, inFlight + 1);
  }

  #releaseToolCall(runId: RunId): void {
    const inFlight = this.#inFlightByRun.get(runId) ?? 0;
    if (inFlight <= 1) this.#inFlightByRun.delete(runId);
    else this.#inFlightByRun.set(runId, inFlight - 1);
  }

  async #resolveRisk(
    tool: AnyRuntimeToolDefinition,
    input: Record<string, unknown>,
    invocation: DispatchRuntimeToolInput,
    toolCallId: ToolCallId,
    prepareIfMissing: boolean,
  ): Promise<ResolvedToolRisk> {
    if (tool.risk.mode === "static") {
      return {
        level: tool.risk.level,
        reversible: tool.risk.reversible,
        sideEffects: [tool.risk.sideEffect],
      };
    }
    if (tool.prepare) {
      const identity = executionIdentity(tool, invocation, toolCallId);
      try {
        return this.#preparedInvocations.require(identity, input).risk;
      } catch (error) {
        if (
          !(error instanceof PreparedToolInvocationRegistryError) ||
          error.code !== "PLAN_NOT_FOUND"
        ) {
          throw normalizePreparedPlanError(error);
        }
        if (!prepareIfMissing) {
          throw normalizePreparedPlanError(error);
        }
      }
      const executor = this.#backendExecutor;
      if (!executor?.prepare) {
        throw new RuntimeToolExecutionError(
          "BACKEND_PREPARE_UNAVAILABLE",
          "Backend prepare executor is not available.",
          true,
          "not_started",
        );
      }
      let prepared: PreparedToolInvocation;
      try {
        prepared = await executor.prepare(
          tool.prepare.operation,
          input,
          identity,
          invocation.abortSignal ?? new AbortController().signal,
        );
      } catch (error) {
        if (error instanceof RuntimeToolExecutionError) {
          throw error;
        }
        throw new RuntimeToolExecutionError(
          "TOOL_PREPARE_FAILED",
          "Tool invocation could not be prepared.",
          false,
          "not_started",
        );
      }
      assertResolvedRiskBaseline(tool, prepared.risk);
      return this.#preparedInvocations.remember(identity, input, prepared).risk;
    }
    let resolved: ResolvedToolRisk;
    try {
      const resolveRisk = tool.resolveRisk;
      if (!resolveRisk) {
        throw new Error("missing risk resolver");
      }
      resolved = await resolveRisk(input, {
        conversationId: invocation.conversationId,
        runId: invocation.runId,
        messageId: invocation.messageId,
        toolCallId,
        toolId: tool.id,
        abortSignal: invocation.abortSignal ?? new AbortController().signal,
      });
    } catch {
      throw new RuntimeToolExecutionError(
        "TOOL_RISK_RESOLUTION_FAILED",
        "Tool risk could not be resolved.",
        false,
        "not_started",
      );
    }
    assertResolvedRiskBaseline(tool, resolved);
    return resolved;
  }

  async #execute(
    tool: AnyRuntimeToolDefinition,
    input: Record<string, unknown>,
    invocation: DispatchRuntimeToolInput,
    toolCallId: ToolCallId,
  ) {
    const timeoutMs = tool.limits?.timeoutMs ?? this.#defaultTimeoutMs;
    const controller = new AbortController();
    const onAbort = () => controller.abort(invocation.abortSignal?.reason);
    invocation.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      const invocationContext = {
        conversationId: invocation.conversationId,
        runId: invocation.runId,
        messageId: invocation.messageId,
        toolCallId,
        toolId: tool.id,
        abortSignal: controller.signal,
        networkAccessScope:
          invocation.snapshot.networkPolicy?.accessScope ??
          DEFAULT_NETWORK_ACCESS_SCOPE,
      };
      const operation = tool.executionTarget === "backend"
        ? this.#executeBackendTool(tool, input, invocationContext)
        : tool.execute(input, invocationContext)
          .then((output) => validateAndFreezeOutput(tool, output));
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new RuntimeToolExecutionError(
              controller.signal.reason === "timeout"
                ? "TOOL_EXECUTION_TIMEOUT"
                : "TOOL_EXECUTION_ABORTED",
              controller.signal.reason === "timeout"
                ? "Tool execution timed out."
                : "Tool execution was aborted.",
              controller.signal.reason === "timeout",
              "unknown",
            ));
          }, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      invocation.abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  async #describePermission(
    tool: AnyRuntimeToolDefinition,
    input: Record<string, unknown>,
    risk: ResolvedToolRisk,
    invocation: DispatchRuntimeToolInput,
    toolCallId: ToolCallId,
  ) {
    const identity = executionIdentity(tool, invocation, toolCallId);
    let preparedDescription = null;
    if (tool.prepare) {
      try {
        preparedDescription =
          this.#preparedInvocations.require(identity, input).permission;
      } catch (error) {
        throw normalizePreparedPlanError(error);
      }
    }
    const described = preparedDescription ?? (tool.describePermission
      ? await tool.describePermission(input, risk, {
          conversationId: invocation.conversationId,
          runId: invocation.runId,
          messageId: invocation.messageId,
          toolCallId,
          toolId: tool.id,
          abortSignal: invocation.abortSignal ?? new AbortController().signal,
        })
      : {});
    const timeoutMs = tool.limits?.timeoutMs ?? this.#defaultTimeoutMs;
    const presentation = {
      ...(described.presentation ?? {}),
      timeoutMs: described.presentation?.timeoutMs ?? timeoutMs,
      ...(tool.limits?.maxResultBytes !== undefined &&
          described.presentation?.maxResultBytes === undefined
        ? { maxResultBytes: tool.limits.maxResultBytes }
        : {}),
    };
    const sqlText = described.presentation?.sql?.text;
    if (
      sqlText &&
      (described.inputSummary?.includes(sqlText) ||
        described.confirmationPrompt?.includes(sqlText))
    ) {
      throw new RuntimeToolExecutionError(
        "TOOL_PERMISSION_DESCRIPTION_INVALID",
        "Raw SQL must not be copied into Permission summaries or confirmation prompts.",
        false,
        "not_started",
      );
    }

    return {
      ...described,
      ...(Object.keys(presentation).length > 0 ? { presentation } : {}),
    };
  }

  async #executeBackendTool(
    tool: AnyRuntimeToolDefinition,
    input: Record<string, unknown>,
    context: Omit<BackendToolExecutionContext, "proceed">,
  ): Promise<Readonly<ToolExecutionOutput<unknown>>> {
    const executor = this.#backendExecutor;
    if (!executor) {
      throw new RuntimeToolExecutionError(
        "BACKEND_EXECUTOR_UNAVAILABLE",
        "Backend tool executor is not available.",
        true,
        "not_started",
      );
    }

    let proceeded = false;
    let proceedCalledMoreThanOnce = false;
    let proceededOutput: Readonly<ToolExecutionOutput<unknown>> | undefined;
    const proceed = async (): Promise<Readonly<ToolExecutionOutput<unknown>>> => {
      if (proceeded) {
        proceedCalledMoreThanOnce = true;
        throw new RuntimeToolExecutionError(
          "BACKEND_PROCEED_ALREADY_CALLED",
          "Backend Tool proceed() can only be called once.",
          false,
          "unknown",
        );
      }
      proceeded = true;
      const identity: BackendToolExecutionIdentity = {
        conversationId: context.conversationId,
        runId: context.runId,
        messageId: context.messageId,
        toolCallId: context.toolCallId,
        toolId: context.toolId,
      };
      const backendInput = tool.prepare
        ? {
            planId: this.#preparedInvocations.require(identity, input).planId,
          }
        : input;
      if (tool.prepare) {
        this.#preparedInvocations.markConsumed(context.toolCallId);
      }
      proceededOutput = validateAndFreezeOutput(
        tool,
        await executor.execute(
          tool.id,
          backendInput,
          context.abortSignal,
          identity,
        ),
      );
      return proceededOutput;
    };

    const returnedOutput = await tool.execute(input, {
      ...context,
      proceed,
    });
    if (proceedCalledMoreThanOnce) {
      throw new RuntimeToolExecutionError(
        "BACKEND_PROCEED_ALREADY_CALLED",
        "Backend Tool proceed() can only be called once.",
        false,
        "unknown",
      );
    }
    if (!proceeded) {
      throw new RuntimeToolExecutionError(
        "BACKEND_PROCEED_NOT_CALLED",
        "Backend Tool execute() must call proceed().",
        false,
        "not_started",
      );
    }
    if (returnedOutput !== proceededOutput) {
      throw new RuntimeToolExecutionError(
        "BACKEND_EXECUTION_RESULT_REPLACED",
        "Backend Tool execute() must return the result from proceed().",
        false,
        "unknown",
      );
    }
    return proceededOutput;
  }

  #requestPermission(
    toolCallId: ToolCallId,
    invocation: DispatchRuntimeToolInput,
    toolId: string,
    title: string,
    input: Record<string, unknown>,
    risk: ResolvedToolRisk,
    createdAt: number,
    description: {
      inputSummary?: string;
      confirmationPrompt?: string;
      presentation?: Permission["presentation"];
    },
    preparedPlan: PreparedPlanLinkMetadata | null,
  ): Permission {
    const permissionId = createRuntimeId("perm");
    const permission: Permission = {
      id: permissionId,
      conversationId: invocation.conversationId,
      runId: invocation.runId,
      messageId: invocation.messageId,
      toolCallId,
      status: "pending",
      toolId,
      title,
      ...(description.inputSummary
        ? { inputSummary: description.inputSummary }
        : {}),
      risk,
      confirmation: risk.level === "critical"
        ? {
            level: "strong",
            prompt:
              description.confirmationPrompt ??
              `确认执行 ${title}（${toolId}）`,
          }
        : { level: "standard" },
      ...(description.presentation
        ? { presentation: description.presentation }
        : {}),
      ...(preparedPlan ? { metadata: { preparedPlan } } : {}),
      createdAt,
    };
    const toolCall: ToolCall = {
      id: toolCallId,
      conversationId: invocation.conversationId,
      runId: invocation.runId,
      messageId: invocation.messageId,
      ...(invocation.partId ? { partId: invocation.partId } : {}),
      toolName: toolId,
      input: redactSecrets(input) as Record<string, unknown>,
      state: "waiting_for_permission",
      permissionId,
      time: { created: createdAt },
      metadata: {
        runtimeToolCore: true,
        snapshotId: invocation.snapshot.snapshotId,
        ...(preparedPlan ? { preparedPlan } : {}),
      },
    };

    this.#store.commitToolPermissionRequest({
      toolCall,
      permission,
      requestedAt: createdAt,
      eventIds: {
        tool: createRuntimeId("evt"),
        permission: createRuntimeId("evt"),
        run: createRuntimeId("evt"),
        conversation: createRuntimeId("evt"),
      },
    });
    return permission;
  }

  #persist(
    id: ToolCallId,
    invocation: DispatchRuntimeToolInput,
    toolId: string,
    input: Record<string, unknown>,
    state: ToolCall["state"],
    created: number,
    started?: number,
    completed?: number,
    result?: RuntimeToolResult<unknown>,
    permissionId?: Permission["id"],
  ): void {
    const error = result && !result.ok ? result.error : undefined;
    const toolCall: ToolCall = {
      id,
      conversationId: invocation.conversationId,
      runId: invocation.runId,
      messageId: invocation.messageId,
      ...(invocation.partId ? { partId: invocation.partId } : {}),
      toolName: toolId,
      input: redactSecrets(input) as Record<string, unknown>,
      state,
      ...(permissionId ? { permissionId } : {}),
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
      time: {
        created,
        ...(started !== undefined ? { started } : {}),
        ...(completed !== undefined ? { completed } : {}),
      },
      metadata: {
        ...(this.#store.getToolCall(id)?.metadata ?? {}),
        runtimeToolCore: true,
        snapshotId: invocation.snapshot.snapshotId,
      },
    };
    this.#store.saveToolCall(toolCall);
    this.#store.appendEvent({
      id: createRuntimeId("evt"),
      type: "tool.updated",
      properties: { info: toolCall },
      time: completed ?? started ?? created,
    });
  }

  #appendTrace(
    invocation: DispatchRuntimeToolInput,
    toolId: string,
    level: TraceEvent["level"],
    time: number,
    payload: Record<string, unknown>,
  ): void {
    this.#store.appendTrace({
      id: createRuntimeId("trace"),
      conversationId: invocation.conversationId,
      runId: invocation.runId,
      type: "tool.executed",
      level,
      time,
      payload: {
        toolId,
        snapshotId: invocation.snapshot.snapshotId,
        ...payload,
      },
    });
  }

  #preparedPlanMetadata(
    tool: AnyRuntimeToolDefinition,
    toolCallId: ToolCallId,
  ): PreparedPlanLinkMetadata | null {
    if (!tool.prepare) return null;
    const metadata = this.#preparedInvocations.metadata(toolCallId);
    return metadata
      ? {
          prepareOperation: tool.prepare.operation,
          expiresAt: metadata.expiresAt,
        }
      : null;
  }
}

function parseObjectInput(
  tool: AnyRuntimeToolDefinition,
  input: unknown,
): Record<string, unknown> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success || !isPlainObject(parsed.data)) {
    throw new RuntimeToolExecutionError(
      "TOOL_INPUT_INVALID",
      "Tool input does not match its input schema.",
      false,
      "not_started",
    );
  }
  return parsed.data;
}

function assertExistingToolCall(
  toolCall: ToolCall,
  invocation: DispatchRuntimeToolInput,
  toolId: string,
  _input: Record<string, unknown>,
): void {
  if (
    toolCall.conversationId !== invocation.conversationId ||
    toolCall.runId !== invocation.runId ||
    toolCall.messageId !== invocation.messageId ||
    toolCall.toolName !== toolId ||
    toolCall.metadata?.snapshotId !== invocation.snapshot.snapshotId ||
    (invocation.partId !== undefined && toolCall.partId !== invocation.partId)
  ) {
    throw new RuntimeToolExecutionError(
      "TOOL_IDENTITY_INVALID",
      "Existing ToolCall does not match this Runtime invocation.",
      false,
      "not_started",
    );
  }
}

function assertPermissionBinding(
  permission: Permission,
  invocation: DispatchRuntimeToolInput,
  toolId: string,
  toolCallId: ToolCallId,
): void {
  if (
    permission.conversationId !== invocation.conversationId ||
    permission.runId !== invocation.runId ||
    permission.messageId !== invocation.messageId ||
    permission.toolCallId !== toolCallId ||
    permission.toolId !== toolId
  ) {
    throw new RuntimeToolExecutionError(
      "TOOL_PERMISSION_BINDING_INVALID",
      "Tool Permission does not match this Runtime invocation.",
      false,
      "not_started",
    );
  }
}

function permissionRequiredResult(): RuntimeToolResult<never> {
  return {
    ok: false,
    error: {
      code: "TOOL_PERMISSION_REQUIRED",
      message: "This tool call requires user permission.",
      retryable: false,
      outcome: "not_started",
    },
  };
}

function validateAndFreezeOutput(
  tool: AnyRuntimeToolDefinition,
  output: ToolExecutionOutput<unknown>,
): Readonly<ToolExecutionOutput<unknown>> {
  if (
    typeof output !== "object" ||
    output === null ||
    typeof output.summary !== "string" ||
    (output.warnings !== undefined &&
      (!Array.isArray(output.warnings) ||
        output.warnings.some((warning) => typeof warning !== "string")))
  ) {
    throw new RuntimeToolExecutionError(
      "TOOL_OUTPUT_INVALID",
      "Tool returned an invalid output envelope.",
      false,
      "unknown",
    );
  }
  const parsedOutput = tool.outputSchema.safeParse(output.data);
  if (!parsedOutput.success) {
    throw new RuntimeToolExecutionError(
      "TOOL_OUTPUT_INVALID",
      "Tool returned data that does not match its output schema.",
      false,
      "unknown",
    );
  }
  return deepFreeze({
    summary: output.summary,
    data: parsedOutput.data,
    ...(output.warnings ? { warnings: [...output.warnings] } : {}),
  });
}

function assertResolvedRiskBaseline(
  tool: AnyRuntimeToolDefinition,
  resolved: ResolvedToolRisk,
): void {
  if (
    !Object.hasOwn(RISK_RANK, resolved.level) ||
    RISK_RANK[resolved.level] < RISK_RANK[tool.risk.level] ||
    typeof resolved.reversible !== "boolean" ||
    !Array.isArray(resolved.sideEffects) ||
    new Set(resolved.sideEffects).size !== resolved.sideEffects.length ||
    resolved.sideEffects.some((effect) => !TOOL_SIDE_EFFECTS.includes(effect)) ||
    !resolved.sideEffects.includes(tool.risk.sideEffect)
  ) {
    throw new RuntimeToolExecutionError(
      "TOOL_RISK_INVALID",
      "Resolved tool risk is lower than its registered baseline.",
      false,
      "not_started",
    );
  }
}

function assertWithinSnapshotCeiling(
  risk: ResolvedToolRisk,
  snapshot: RunToolSnapshot,
): void {
  if (
    RISK_RANK[risk.level] > RISK_RANK[snapshot.executionCeiling.maxRiskLevel] ||
    risk.sideEffects.some(
      (effect) => !snapshot.executionCeiling.allowedSideEffects.includes(effect),
    ) ||
    (!snapshot.executionCeiling.allowIrreversible && !risk.reversible)
  ) {
    throw new RuntimeToolExecutionError(
      "TOOL_EXECUTION_CEILING_EXCEEDED",
      "Tool risk exceeds this run's execution ceiling.",
      false,
      "not_started",
    );
  }
}

function defaultPolicy(context: RuntimeToolPolicyContext): RuntimePolicyDecision {
  if (
    context.risk.level === "high" ||
    context.risk.level === "critical"
  ) {
    return "ask";
  }

  const maxRisk =
    context.snapshot.approvalPolicy?.autoApproveMaxRisk ?? "low";
  if (maxRisk === "none") {
    return "ask";
  }
  if (maxRisk === "medium") {
    return "allow";
  }
  return context.risk.level === "low" ? "allow" : "ask";
}

function executionIdentity(
  tool: AnyRuntimeToolDefinition,
  invocation: DispatchRuntimeToolInput,
  toolCallId: ToolCallId,
): BackendToolExecutionIdentity {
  return {
    conversationId: invocation.conversationId,
    runId: invocation.runId,
    messageId: invocation.messageId,
    toolCallId,
    toolId: tool.id,
  };
}

function normalizePreparedPlanError(error: unknown): RuntimeToolExecutionError {
  if (error instanceof RuntimeToolExecutionError) {
    return error;
  }
  if (error instanceof PreparedToolInvocationRegistryError) {
    return new RuntimeToolExecutionError(
      error.code,
      error.message,
      false,
      "not_started",
    );
  }
  return new RuntimeToolExecutionError(
    "PLAN_MISMATCH",
    "Prepared plan state is invalid.",
    false,
    "not_started",
  );
}

function isDeeplyFrozenSnapshot(snapshot: RunToolSnapshot): boolean {
  return (
    Object.isFrozen(snapshot) &&
    Object.isFrozen(snapshot.executionCeiling) &&
    Object.isFrozen(snapshot.executionCeiling.allowedSideEffects) &&
    Object.isFrozen(snapshot.activeTools) &&
    snapshot.activeTools.every(Object.isFrozen) &&
    (snapshot.unavailableTools === undefined ||
      (Object.isFrozen(snapshot.unavailableTools) &&
        snapshot.unavailableTools.every(Object.isFrozen)))
  );
}

function normalizeError(error: unknown): RuntimeToolError {
  if (error instanceof RuntimeToolExecutionError) {
    return normalizeRuntimeToolError(error);
  }
  if (isRuntimeToolError(error)) {
    return normalizeRuntimeToolError(error);
  }
  return {
    code: "TOOL_EXECUTION_FAILED",
    message: "Tool execution failed.",
    retryable: false,
    outcome: "unknown",
  };
}

function isRuntimeToolError(value: unknown): value is RuntimeToolError {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    ["not_started", "no_effect", "unknown"].includes(String(value.outcome))
  );
}

function normalizeRuntimeToolError(error: RuntimeToolError): RuntimeToolError {
  const details = safeErrorDetails(error.details);
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    outcome: error.outcome,
    ...(details ? { details } : {}),
  };
}

function safeErrorDetails(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const redacted = redactSecrets(value);
  return isPlainObject(redacted) ? redacted : undefined;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSecrets(item),
    ]),
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    deepFreeze(item);
  }
  return Object.freeze(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
