import { AgentModeSelector } from "@/features/workbench/agent/mode";
import { AgentModelSelector } from "@/features/workbench/agent/model";

import { AgentComposerContextDisplay } from "./AgentComposerContextDisplay";

interface AgentComposerControlsProps {
  onModelSettingsRequested?: () => void;
}

export function AgentComposerControls({
  onModelSettingsRequested,
}: AgentComposerControlsProps) {
  return (
    <>
      <AgentModeSelector />
      <AgentModelSelector onModelSettingsRequested={onModelSettingsRequested} />
      <AgentComposerContextDisplay />
    </>
  );
}
