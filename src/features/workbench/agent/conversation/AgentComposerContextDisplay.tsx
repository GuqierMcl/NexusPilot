"use client";

import { ContextDisplay } from "@/components/assistant-ui/context-display";
import { useSelectedAiRuntimeModel } from "@/features/workbench/agent/model";

export function AgentComposerContextDisplay() {
  const { selectedModel } = useSelectedAiRuntimeModel();
  const contextLength = selectedModel?.contextLength;

  if (!contextLength || !Number.isFinite(contextLength) || contextLength <= 0) {
    return null;
  }

  return <ContextDisplay.Ring modelContextWindow={contextLength} side="top" />;
}
