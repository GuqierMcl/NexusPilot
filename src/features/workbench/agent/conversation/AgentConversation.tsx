"use client";

import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { SquareIcon } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";

import { Thread, VirtualizedThread } from "@/components/assistant-ui/thread";
import { Button } from "@/components/ui/button";
import { useAgentRuntimeInterruptController } from "@/features/workbench/agent/runtime/run-interrupt-context";
import { useAgentMessageEditController } from "@/features/workbench/agent/runtime/agent-message-edit-context";
import { useSettingsStore } from "@/store/slices/settings-slice";

import { AgentComposerControls } from "./AgentComposerControls";
import { AgentRuntimeMessageStatus } from "./AgentRuntimeMessageStatus";

interface AgentConversationProps {
  onModelSettingsRequested?: () => void;
}

const AgentModelSettingsRequestContext = createContext<(() => void) | undefined>(
  undefined,
);

export function AgentConversation({
  onModelSettingsRequested,
}: AgentConversationProps) {
  const conversationRendering = useSettingsStore(
    (state) => state.ai.conversationRendering,
  );
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const messageEditController = useAgentMessageEditController();
  const [activeRendering, setActiveRendering] = useState(conversationRendering);

  useEffect(() => {
    if (!isRunning) {
      setActiveRendering(conversationRendering);
    }
  }, [conversationRendering, isRunning]);

  const ConversationThread =
    activeRendering === "virtualized" ? VirtualizedThread : Thread;

  return (
    <AgentModelSettingsRequestContext.Provider value={onModelSettingsRequested}>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ConversationThread
          variant="workbench"
          onUserMessageEditStart={messageEditController?.beginEdit}
          onUserMessageEditCancel={messageEditController?.cancelEdit}
          components={{
            AssistantMessageStatus: AgentRuntimeMessageStatus,
            ComposerFooterStart: AgentComposerControlsWithSettings,
            ComposerCancelAction: AgentRuntimeComposerCancelAction,
          }}
        />
      </div>
    </AgentModelSettingsRequestContext.Provider>
  );
}

function AgentComposerControlsWithSettings() {
  const onModelSettingsRequested = useContext(AgentModelSettingsRequestContext);

  return (
    <AgentComposerControls onModelSettingsRequested={onModelSettingsRequested} />
  );
}

function AgentRuntimeComposerCancelAction() {
  const interrupt = useAgentRuntimeInterruptController();

  return (
    <ComposerPrimitive.Cancel asChild>
      <Button
        type="button"
        variant="default"
        size="icon"
        className="aui-composer-cancel size-7 rounded-full"
        aria-label="停止生成"
        onClick={() => {
          void interrupt.interruptCurrentRun({
            message: "user requested stop",
          });
        }}
      >
        <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
      </Button>
    </ComposerPrimitive.Cancel>
  );
}
