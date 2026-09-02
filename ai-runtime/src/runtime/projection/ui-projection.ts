import type { DiffArtifact, DiffLine, Message, Part } from "../core/types";

export interface UiMessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  parts: UiPartLike[];
  metadata?: Record<string, unknown>;
}

export type UiPartLike =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "source"; sourceType: "url"; id?: string; url: string; title?: string }
  | { type: "file"; filename: string; mimeType: string; data: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      argsText: string;
      result?: unknown;
      isError?: boolean;
    };

type ToolProjectionState = Extract<Part, { type: "tool" }>["state"];

export function projectMessageToUiMessage(message: Message): UiMessageLike {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts.flatMap(projectPartToUiParts),
    metadata: {
      nexus: {
        conversationId: message.conversationId,
        messageMetadata: message.metadata,
        ...(message.role === "assistant"
          ? {
              runId: message.runId,
              providerId: message.providerId,
              modelId: message.modelId,
              agentMode: message.agentMode,
              usage: message.usage,
              cost: message.cost,
              finish: message.finish,
              ...(message.status.type !== "complete"
                ? { status: message.status }
                : {}),
              ...(message.metadata?.interrupt
                ? { interrupt: message.metadata.interrupt }
                : {}),
            }
          : {}),
      },
    },
  };
}

export function projectPartToUiParts(part: Part): UiPartLike[] {
  switch (part.type) {
    case "text":
      return [{ type: "text", text: part.text }];
    case "reasoning":
      return [{ type: "reasoning", text: part.redacted ? "[reasoning redacted]" : part.text }];
    case "source":
      return [
        {
          type: "source",
          sourceType: "url",
          id: part.sourceId ?? part.id,
          url: part.url,
          title: part.title,
        },
      ];
    case "file":
      return [
        {
          type: "file",
          filename: part.filename,
          mimeType: part.mediaType,
          data: `nexuspilot-attachment:${part.attachmentId}`,
        },
      ];
    case "tool": {
      const args = extractToolArgs(part.state);
      return [
        {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args,
          argsText: JSON.stringify(args),
          result: extractToolResult(part.state),
          isError: part.state.status === "error" || part.state.status === "interrupted",
        },
      ];
    }
    case "diff":
      return [{ type: "text", text: renderDiffMarkdown(part.diff) }];
    case "error":
      return [{ type: "text", text: `Error: ${part.error.name}` }];
    case "step-start":
    case "step-finish":
    case "retry":
    case "compaction":
      return [];
  }
}

export function renderDiffMarkdown(diff: DiffArtifact): string {
  const target = formatDiffTarget(diff);
  const lines = diff.hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines.map(renderDiffLine),
  ]);

  return [
    `### ${diff.title}`,
    "",
    diff.summary ? `${diff.summary}` : "",
    "",
    `Target: \`${target}\``,
    "",
    "```diff",
    ...lines,
    "```",
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}

function renderDiffLine(line: DiffLine): string {
  if (line.type === "add") {
    return `+${line.text}`;
  }

  if (line.type === "remove") {
    return `-${line.text}`;
  }

  return ` ${line.text}`;
}

function formatDiffTarget(diff: DiffArtifact): string {
  switch (diff.target.type) {
    case "memory":
      return diff.target.name;
    case "workspace_file":
      return diff.target.path;
    case "business_object":
      return diff.target.label ?? `${diff.target.objectType}:${diff.target.objectId}`;
  }
}

function extractToolArgs(state: ToolProjectionState): Record<string, unknown> {
  const maybeInput = "input" in state ? state.input : undefined;
  return isRecord(maybeInput) ? maybeInput : {};
}

function extractToolResult(state: ToolProjectionState): unknown {
  if (state.status === "completed") {
    return state.output;
  }

  if (state.status === "error") {
    return state.error;
  }

  if (state.status === "interrupted") {
    return {
      code: "INTERRUPTED",
      message: state.reason ?? "Tool call interrupted",
      retryable: false,
    };
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
