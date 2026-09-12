import {
  referenceKey,
  type ReferencedText,
} from "@contracts/composer-references";

/** Inverse of the UI's joined text projection, retaining original part order. */
export function splitReferencedText(
  value: ReferencedText,
  texts: readonly string[],
): ReferencedText[] {
  if (texts.join("\n\n") !== value.text)
    throw new Error("引用正文与消息不一致");
  let offset = 0;
  let assigned = 0;
  const parts = texts.map((text) => {
    const occurrences = (value.references?.occurrences ?? [])
      .filter(
        (item) => item.start >= offset && item.end <= offset + text.length,
      )
      .map((item) => ({
        ...item,
        start: item.start - offset,
        end: item.end - offset,
      }));
    assigned += occurrences.length;
    const used = new Set(occurrences.map((item) => item.targetKey));
    const targets =
      value.references?.targets.filter((target) =>
        used.has(referenceKey(target)),
      ) ?? [];
    const command =
      value.command &&
      value.command.start >= offset &&
      value.command.end <= offset + text.length
        ? {
            ...value.command,
            start: value.command.start - offset,
            end: value.command.end - offset,
          }
        : undefined;
    offset += text.length + 2;
    return {
      text,
      ...(command ? { command } : {}),
      ...(occurrences.length
        ? { references: { version: 1 as const, targets, occurrences } }
        : {}),
    };
  });
  if (value.command && !parts.some((part) => part.command))
    throw new Error("命令不能跨越消息片段");
  if (assigned !== (value.references?.occurrences.length ?? 0))
    throw new Error("引用不能跨越消息片段");
  return parts;
}
