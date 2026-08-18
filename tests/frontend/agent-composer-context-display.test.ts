import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const conversationPath = join(
  import.meta.dir,
  "../../src/features/workbench/agent/conversation/AgentConversation.tsx",
);
const controlsPath = join(
  import.meta.dir,
  "../../src/features/workbench/agent/conversation/AgentComposerControls.tsx",
);
const displayPath = join(
  import.meta.dir,
  "../../src/features/workbench/agent/conversation/AgentComposerContextDisplay.tsx",
);

async function readSource(path: string): Promise<string> {
  return (await Bun.file(path).text()).replace(/\r\n/g, "\n");
}

describe("agent composer context display", () => {
  test("renders beside the model selector instead of the centered composer status slot", async () => {
    const [conversationSource, controlsSource] = await Promise.all([
      readSource(conversationPath),
      readSource(controlsPath),
    ]);

    expect(controlsSource).toContain("<AgentModelSelector");
    expect(controlsSource).toContain("<AgentComposerContextDisplay />");
    expect(conversationSource).not.toContain("ComposerFooterStatus");
  });

  test("uses the selected model context length for the compact context indicator", async () => {
    const source = await readSource(displayPath);

    expect(source).toContain("useSelectedAiRuntimeModel");
    expect(source).toContain("modelContextWindow={contextLength}");
    expect(source).toContain("<ContextDisplay.Ring");
  });
});
