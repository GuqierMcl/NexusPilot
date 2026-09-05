"use client";

import {
  ContextDisplay,
  ContextDisplayRingBody,
  ContextDisplayRootView,
} from "@/components/assistant-ui/context-display";
import { useSelectedAiRuntimeModel } from "@/features/workbench/agent/model";
import {
  getRuntimeContextUsageState,
  type RuntimeContextUsageState,
} from "@/features/workbench/agent/state";
import { useAuiState } from "@assistant-ui/react";

export function AgentComposerContextDisplayView({
  currentThreadId,
  selectedModelContextLength,
  runtimeUsageState,
}: {
  currentThreadId: string;
  selectedModelContextLength?: number;
  runtimeUsageState: RuntimeContextUsageState;
}) {
  const runtimeUsage = runtimeUsageState.kind === "valid"
    ? runtimeUsageState.value
    : null;
  const legacyContextLength = selectedModelContextLength
    && Number.isFinite(selectedModelContextLength)
    && selectedModelContextLength > 0
    ? selectedModelContextLength
    : 0;

  if (runtimeUsageState.kind === "absent") {
    return legacyContextLength > 0
      ? <ContextDisplay.Ring modelContextWindow={legacyContextLength} side="top" />
      : null;
  }

  return (
    <ContextDisplayRootView
      currentThreadId={currentThreadId}
      modelContextWindow={runtimeUsage?.contextWindow ?? 0}
      usage={undefined}
      persistedTokenState={{
        threadId: currentThreadId,
        totalTokens: 0,
        usage: undefined,
      }}
      runtimeUsage={runtimeUsage}
      runtimeUsageInvalid={runtimeUsageState.kind === "invalid"}
    >
      <ContextDisplayRingBody side="top" />
    </ContextDisplayRootView>
  );
}

export function AgentComposerContextDisplay() {
  const { selectedModel } = useSelectedAiRuntimeModel();
  const currentThreadId = useAuiState((state) => state.threadListItem.id);
  const runtimeUsageState = useAuiState((state) => {
    for (let index = state.thread.messages.length - 1; index >= 0; index -= 1) {
      const message = state.thread.messages[index];
      if (message?.role === "assistant") {
        return getRuntimeContextUsageState(message.metadata);
      }
    }
    return { kind: "absent" } as const;
  });

  return (
    <AgentComposerContextDisplayView
      currentThreadId={currentThreadId}
      selectedModelContextLength={selectedModel?.contextLength}
      runtimeUsageState={runtimeUsageState}
    />
  );
}
