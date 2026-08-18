import type { ConversationId, InterruptReason, RunId } from "../core/types";
import type { InterruptStoredRunResult } from "./run-interrupt";

export interface ActiveRunInterruptRequest {
  reason: InterruptReason;
  message?: string;
}

export interface ActiveRunRegistration {
  runId: RunId;
  conversationId: ConversationId;
  interrupt(request: ActiveRunInterruptRequest): InterruptStoredRunResult | null;
}

export class ActiveRunRegistry {
  private readonly activeByRunId = new Map<RunId, ActiveRunRegistration>();
  private readonly runIdByConversationId = new Map<ConversationId, RunId>();

  register(registration: ActiveRunRegistration): () => void {
    this.unregisterRun(registration.runId);

    const existingRunId = this.runIdByConversationId.get(registration.conversationId);
    if (existingRunId) {
      this.unregisterRun(existingRunId);
    }

    this.activeByRunId.set(registration.runId, registration);
    this.runIdByConversationId.set(registration.conversationId, registration.runId);

    return () => {
      this.unregisterRun(registration.runId);
    };
  }

  getActiveRunId(conversationId: ConversationId): RunId | null {
    return this.runIdByConversationId.get(conversationId) ?? null;
  }

  interruptRun(
    runId: RunId,
    request: ActiveRunInterruptRequest,
  ): InterruptStoredRunResult | null {
    const registration = this.activeByRunId.get(runId);
    if (!registration) {
      return null;
    }

    try {
      return registration.interrupt(request);
    } finally {
      this.unregisterRun(runId);
    }
  }

  interruptConversation(
    conversationId: ConversationId,
    request: ActiveRunInterruptRequest,
  ): InterruptStoredRunResult | null {
    const runId = this.runIdByConversationId.get(conversationId);
    if (!runId) {
      return null;
    }

    return this.interruptRun(runId, request);
  }

  unregisterRun(runId: RunId): void {
    const registration = this.activeByRunId.get(runId);
    if (!registration) {
      return;
    }

    this.activeByRunId.delete(runId);
    const currentRunId = this.runIdByConversationId.get(registration.conversationId);
    if (currentRunId === runId) {
      this.runIdByConversationId.delete(registration.conversationId);
    }
  }
}
