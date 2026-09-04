import { describe, expect, test } from "bun:test";
import {
  runtimeEventScopeMatches,
  runtimeEventToEnvelope,
  type Event,
  type RuntimeEventScopeFilter,
} from "../src/runtime";

describe("runtime event envelope", () => {
  test("projects a run event to a run-scoped live envelope", () => {
    const event: Event = {
      id: "evt_run",
      type: "run.updated",
      properties: {
        info: {
          id: "run_live",
          conversationId: "conv_live",
          agentMode: "ask",
          providerId: "openai",
          modelId: "gpt-4o",
          status: "completed",
          input: { messageIds: ["msg_user"] },
          limits: { maxSteps: 4, maxToolCalls: 8 },
          time: { created: 1, started: 2, completed: 3 },
        },
      },
      time: 3,
    };

    expect(runtimeEventToEnvelope(event)).toEqual({
      id: "evt_run",
      type: "run.updated",
      scope: {
        kind: "run",
        conversation_id: "conv_live",
        run_id: "run_live",
      },
      occurred_at: 3,
      version: 1,
      payload: { event },
    });
  });

  test("projects conversation and runtime error events to their narrowest scope", () => {
    const conversationEvent: Event = {
      id: "evt_conversation",
      type: "conversation.status",
      properties: {
        conversationId: "conv_live",
        status: { type: "idle" },
      },
      time: 10,
    };
    const runtimeErrorEvent: Event = {
      id: "evt_error",
      type: "runtime.error",
      properties: {
        conversationId: "conv_live",
        runId: "run_live",
        error: { name: "UnknownError", data: { message: "boom" } },
      },
      time: 11,
    };

    expect(runtimeEventToEnvelope(conversationEvent).scope).toEqual({
      kind: "conversation",
      conversation_id: "conv_live",
    });
    expect(runtimeEventToEnvelope(runtimeErrorEvent).scope).toEqual({
      kind: "run",
      conversation_id: "conv_live",
      run_id: "run_live",
    });
  });

  test("projects conversation info events by conversation id", () => {
    const event: Event = {
      id: "evt_conversation_created",
      type: "conversation.created",
      properties: {
        info: {
          id: "conv_live",
          title: "New conversation",
          version: "1",
          status: { type: "idle" },
          revision: 0,
          time: { created: 1, updated: 1 },
        },
      },
      time: 1,
    };

    expect(runtimeEventToEnvelope(event).scope).toEqual({
      kind: "conversation",
      conversation_id: "conv_live",
    });
  });

  test("matches global conversation and run subscription scopes", () => {
    const runEnvelope = runtimeEventToEnvelope({
      id: "evt_run",
      type: "run.updated",
      properties: {
        info: {
          id: "run_live",
          conversationId: "conv_live",
          agentMode: "ask",
          providerId: "openai",
          modelId: "gpt-4o",
          status: "running",
          input: { messageIds: ["msg_user"] },
          limits: { maxSteps: 4, maxToolCalls: 8 },
          time: { created: 1, started: 2 },
        },
      },
      time: 2,
    });

    const global: RuntimeEventScopeFilter = { kind: "global" };
    const sameConversation: RuntimeEventScopeFilter = {
      kind: "conversation",
      conversation_id: "conv_live",
    };
    const otherConversation: RuntimeEventScopeFilter = {
      kind: "conversation",
      conversation_id: "conv_other",
    };
    const sameRun: RuntimeEventScopeFilter = { kind: "run", run_id: "run_live" };
    const otherRun: RuntimeEventScopeFilter = { kind: "run", run_id: "run_other" };

    expect(runtimeEventScopeMatches(global, runEnvelope.scope)).toBe(true);
    expect(runtimeEventScopeMatches(sameConversation, runEnvelope.scope)).toBe(true);
    expect(runtimeEventScopeMatches(otherConversation, runEnvelope.scope)).toBe(false);
    expect(runtimeEventScopeMatches(sameRun, runEnvelope.scope)).toBe(true);
    expect(runtimeEventScopeMatches(otherRun, runEnvelope.scope)).toBe(false);
  });

  test("whitelists context event identity and budget facts in live envelopes", () => {
    const event = {
      id: "evt_context",
      type: "context.checkpoint.created",
      properties: {
        checkpointId: "ckpt_1",
        conversationId: "conv_live",
        sourceHeadRunId: "run_live",
        sourceConversationRevision: 3,
        coverageThroughRunId: "run_previous",
        trigger: "auto_pre_turn",
        formatVersion: "1",
        compatibility: { kind: "provider-neutral-text", version: 1 },
        budget: {
          contextWindow: 10_000,
          estimatedInputTokens: 7_000,
          rawHistoryTokens: 6_000,
          checkpointTokens: 500,
          safetyStateTokens: 100,
          reservedOutputTokens: 1_000,
        },
        summary: "must not leave the Runtime Store",
        safetyState: { effects: [{ target: "secret" }] },
        generatedBy: { providerId: "secret-provider", modelId: "secret-model" },
        attachmentBytes: "AAEC",
      },
      time: 20,
    } as unknown as Event;

    const envelope = runtimeEventToEnvelope(event);
    expect(envelope.scope).toEqual({
      kind: "conversation",
      conversation_id: "conv_live",
    });
    expect(envelope.payload).toEqual({
      event: {
        id: "evt_context",
        type: "context.checkpoint.created",
        properties: {
          checkpointId: "ckpt_1",
          conversationId: "conv_live",
          sourceHeadRunId: "run_live",
          sourceConversationRevision: 3,
          coverageThroughRunId: "run_previous",
          trigger: "auto_pre_turn",
          formatVersion: "1",
          compatibility: { kind: "provider-neutral-text", version: 1 },
          budget: {
            contextWindow: 10_000,
            estimatedInputTokens: 7_000,
            rawHistoryTokens: 6_000,
            checkpointTokens: 500,
            safetyStateTokens: 100,
            reservedOutputTokens: 1_000,
          },
        },
        time: 20,
      },
    });
  });

  test("whitelists context plan identity, selection, reason, and budget facts", () => {
    const event = {
      id: "evt_context_plan",
      type: "context.plan.created",
      properties: {
        planId: "ctxplan_1",
        conversationId: "conv_live",
        runId: "run_live",
        requestIndex: 2,
        sourceHeadRunId: "run_live",
        sourceConversationRevision: 4,
        view: "checkpoint",
        checkpointId: "ckpt_1",
        reason: "checkpoint_selected",
        trigger: "auto_pre_turn",
        budget: {
          contextWindow: 10_000,
          estimatedInputTokens: 4_000,
          rawHistoryTokens: 2_000,
          checkpointTokens: 500,
          safetyStateTokens: 100,
          reservedOutputTokens: 1_000,
          secretEstimate: 999,
        },
        safetyState: { effects: [{ target: "secret" }] },
        summary: "must not leave the Runtime Store",
        generatedBy: { providerId: "secret-provider", modelId: "secret-model" },
        arbitrary: "must be removed",
      },
      time: 21,
    } as unknown as Event;

    expect(runtimeEventToEnvelope(event)).toEqual({
      id: "evt_context_plan",
      type: "context.plan.created",
      scope: {
        kind: "run",
        conversation_id: "conv_live",
        run_id: "run_live",
      },
      occurred_at: 21,
      version: 1,
      payload: {
        event: {
          id: "evt_context_plan",
          type: "context.plan.created",
          properties: {
            planId: "ctxplan_1",
            conversationId: "conv_live",
            runId: "run_live",
            requestIndex: 2,
            sourceHeadRunId: "run_live",
            sourceConversationRevision: 4,
            view: "checkpoint",
            checkpointId: "ckpt_1",
            reason: "checkpoint_selected",
            trigger: "auto_pre_turn",
            budget: {
              contextWindow: 10_000,
              estimatedInputTokens: 4_000,
              rawHistoryTokens: 2_000,
              checkpointTokens: 500,
              safetyStateTokens: 100,
              reservedOutputTokens: 1_000,
            },
          },
          time: 21,
        },
      },
    });
  });
});
