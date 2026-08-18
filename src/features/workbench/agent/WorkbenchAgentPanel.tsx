"use client";

import { useState } from "react";

import { AiRuntimeAvailabilityGate } from "@/components/ai-runtime-availability-gate";

import type { AgentPanelBodyMode } from "./agent-panel-mode";
import { AgentConversation } from "./conversation";
import { AgentHistoryView } from "./history";
import { AgentAssistantRuntimeProvider } from "./runtime";
import { AgentStatusBar } from "./status-bar";

type AgentSettingsTarget = "ai-preferences" | "model";

interface WorkbenchAgentPanelProps {
  onSettingsRequested?: (target: AgentSettingsTarget) => void;
}

function AgentPanelContent({
  onSettingsRequested,
}: WorkbenchAgentPanelProps) {
  const [bodyMode, setBodyMode] = useState<AgentPanelBodyMode>("chat");

  return (
    <AgentAssistantRuntimeProvider>
      <div className="relative flex size-full flex-col overflow-hidden">
        <AgentStatusBar
          bodyMode={bodyMode}
          onChatRequested={() => {
            setBodyMode("chat");
          }}
          onHistoryToggle={() => {
            setBodyMode((current) => (current === "history" ? "chat" : "history"));
          }}
          onSettingsRequested={() => onSettingsRequested?.("ai-preferences")}
        />
        {bodyMode === "history" ? (
          <AgentHistoryView
            onConversationSelected={() => {
              setBodyMode("chat");
            }}
          />
        ) : (
          <AgentConversation
            onModelSettingsRequested={() => onSettingsRequested?.("model")}
          />
        )}
      </div>
    </AgentAssistantRuntimeProvider>
  );
}

export function WorkbenchAgentPanel({
  onSettingsRequested,
}: WorkbenchAgentPanelProps) {
  return (
    <AiRuntimeAvailabilityGate
      className="size-full"
      preview={
        <AgentPanelContent
          onSettingsRequested={onSettingsRequested}
        />
      }
    >
      <AgentPanelContent
        onSettingsRequested={onSettingsRequested}
      />
    </AiRuntimeAvailabilityGate>
  );
}
