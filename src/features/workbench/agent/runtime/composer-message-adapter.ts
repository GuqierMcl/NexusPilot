import type { AppendMessage } from "@assistant-ui/react";
import type { CreateUIMessage, UIMessage } from "ai";
import { readComposerReferenceMetadata } from "../../../../../shared/composer-references";
import { ACTIVE_TAB_PART, parseActiveTabContext } from "../../../../../shared/active-tab-context";

/** Keep annotations on the optimistic user message as well as its HTTP input. */
export function createComposerMessage<T extends UIMessage = UIMessage>(
  message: AppendMessage,
): CreateUIMessage<T> {
  const input = [
    ...message.content,
    ...(message.attachments?.flatMap((attachment) =>
      attachment.content.map((part) => ({
        ...part,
        filename: attachment.name,
        contentType: attachment.contentType,
      })),
    ) ?? []),
  ];
  const submitted = readComposerReferenceMetadata({
    custom: {
      composerReferences:
        message.runConfig?.custom?.submittedComposerReferences,
    },
  });
  const current = readComposerReferenceMetadata({
    custom: message.runConfig?.custom,
  });
  const parts: UIMessage["parts"] = input.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "file")
      return {
        type: "file",
        url: part.data,
        mediaType: part.mimeType,
        ...("filename" in part && part.filename
          ? { filename: part.filename }
          : {}),
      };
    if (part.type === "image")
      return {
        type: "file",
        url: part.image,
        mediaType:
          "contentType" in part &&
          typeof part.contentType === "string" &&
          part.contentType.startsWith("image/")
            ? part.contentType
            : (/^data:([^;,]+)/.exec(part.image)?.[1] ?? "image/png"),
        ...("filename" in part && part.filename
          ? { filename: part.filename }
          : {}),
      };
    if (part.type === "data")
      return { type: `data-${part.name}`, data: part.data };
    throw new Error(`Unsupported composer content: ${part.type}`);
  });
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const annotated = submitted?.text === text ? submitted : current;
  // The form captures this before assistant-ui awaits uploads or clears the composer.
  const custom = message.runConfig?.custom;
  if (custom && "submittedActiveTabContext" in custom) {
    for (let index = parts.length - 1; index >= 0; index--) {
      if (parts[index]?.type === ACTIVE_TAB_PART) parts.splice(index, 1);
    }
    if (custom.submittedActiveTabContext != null) {
      parts.push({ type: ACTIVE_TAB_PART, data: parseActiveTabContext(custom.submittedActiveTabContext) });
    }
  }
  return {
    role: message.role,
    parts,
    metadata: {
      ...message.metadata,
      custom: {
        ...message.metadata?.custom,
        ...(annotated?.text === text &&
        (annotated.references || annotated.command)
          ? { composerReferences: annotated }
          : {}),
      },
    },
  } as CreateUIMessage<T>;
}
