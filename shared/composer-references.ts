import { z } from "zod";
import {
  validateCommandBinding,
  type CommandBinding,
} from "./composer-commands";

export const REFERENCE_LIMITS = Object.freeze({
  occurrences: 32,
  targets: 16,
  bytes: 32 * 1024,
});
const identifier = z.string().min(1).max(256);
const displayLabel = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n\u0000]/.test(value));
export const referenceTargetSchema = z
  .object({
    sourceId: identifier,
    type: identifier,
    version: z.number().int().positive(),
    id: identifier,
    label: displayLabel,
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ReferenceTarget = z.infer<typeof referenceTargetSchema>;
export const referenceOccurrenceSchema = z
  .object({
    id: identifier,
    label: displayLabel.optional(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    targetKey: z.string().min(1).max(1024),
  })
  .strict();
export type ReferenceOccurrence = z.infer<typeof referenceOccurrenceSchema>;
export const textReferencesSchema = z
  .object({
    version: z.literal(1),
    targets: z.array(referenceTargetSchema).max(REFERENCE_LIMITS.targets),
    occurrences: z
      .array(referenceOccurrenceSchema)
      .max(REFERENCE_LIMITS.occurrences),
  })
  .strict();
export type TextReferences = z.infer<typeof textReferencesSchema>;
// Convert with the same Zod instance that owns the schema. Workspaces may use
// different minor versions of Zod; only the JSON description crosses that boundary.
export function textReferencesOpenApiSchema() {
  return z.toJSONSchema(textReferencesSchema, {
    target: "openapi-3.0",
    unrepresentable: "any",
  });
}
export interface ReferencedText {
  text: string;
  references?: TextReferences;
  command?: CommandBinding;
  /** Server-owned snapshot, never accepted from HTTP input or exposed as UI text. */
  commandPrompt?: string;
}

export function referenceKey(target: ReferenceTarget): string {
  return JSON.stringify([
    target.sourceId,
    target.type,
    target.version,
    target.id,
  ]);
}

export interface ReferenceTypeHandler {
  type: string;
  version: number;
  dataSchema: z.ZodType<Record<string, unknown>>;
  describe: (target: ReferenceTarget) => Record<string, unknown>;
}

/** Explicitly assembled, private map: neither callers nor UI registries can mutate it. */
export function createReferenceTypeRegistry(
  definitions: readonly ReferenceTypeHandler[],
) {
  const handlers = new Map<string, ReferenceTypeHandler>();
  for (const definition of definitions) {
    const key = JSON.stringify([definition.type, definition.version]);
    if (
      !definition.type ||
      !Number.isInteger(definition.version) ||
      definition.version < 1 ||
      handlers.has(key)
    ) {
      throw new Error(`Invalid or duplicate reference handler: ${key}`);
    }
    handlers.set(key, Object.freeze({ ...definition }));
  }
  const get = (target: ReferenceTarget): ReferenceTypeHandler => {
    const handler = handlers.get(JSON.stringify([target.type, target.version]));
    if (!handler)
      throw new Error(
        `Unsupported reference type: ${target.type}@${target.version}`,
      );
    return handler;
  };
  return Object.freeze({
    validate(target: ReferenceTarget): void {
      get(target).dataSchema.parse(target.data);
    },
    describe(target: ReferenceTarget): Record<string, unknown> {
      const handler = get(target);
      handler.dataSchema.parse(target.data);
      return handler.describe(target);
    },
  });
}
export const connectionReferenceHandler: ReferenceTypeHandler = {
  type: "connection",
  version: 1,
  dataSchema: z.object({ driver: identifier }).strict(),
  describe: (target) => ({
    profileId: target.id,
    name: target.label,
    driver: target.data.driver,
  }),
};
export const referenceTypes = createReferenceTypeRegistry([
  connectionReferenceHandler,
]);

function splitsSurrogate(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[offset]!)
  );
}

export function validateTextReferences(
  text: string,
  input: unknown,
  registry = referenceTypes,
): TextReferences {
  const value = textReferencesSchema.parse(input);
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    REFERENCE_LIMITS.bytes
  ) {
    throw new Error("引用信息超过 32 KiB 上限");
  }
  const targets = new Map<string, ReferenceTarget>();
  for (const target of value.targets) {
    registry.validate(target);
    const key = referenceKey(target);
    if (targets.has(key)) throw new Error("重复的引用目标");
    targets.set(key, target);
  }
  const ids = new Set<string>();
  const used = new Set<string>();
  let end = 0;
  for (const item of value.occurrences) {
    const target = targets.get(item.targetKey);
    if (
      ids.has(item.id) ||
      !target ||
      item.start < end ||
      item.end <= item.start ||
      item.end > text.length ||
      splitsSurrogate(text, item.start) ||
      splitsSurrogate(text, item.end) ||
      text.slice(item.start, item.end) !== `@${item.label ?? target.label}`
    ) {
      throw new Error("引用范围或目标无效");
    }
    ids.add(item.id);
    used.add(item.targetKey);
    end = item.end;
  }
  if (used.size !== targets.size) throw new Error("引用目标缺少对应正文");
  return value;
}

export function validateReferenceMessage(
  parts: readonly ReferencedText[],
): void {
  let commandCount = 0;
  for (const part of parts) {
    if (!part.command) continue;
    const command = validateCommandBinding(part.text, part.command);
    if (++commandCount > 1) throw new Error("每条消息最多一个消息命令");
    if (
      part.references?.occurrences.some(
        (ref) => ref.start < command.end && command.start < ref.end,
      )
    )
      throw new Error("命令与引用范围交叠");
  }
  let count = 0;
  const targets = new Set<string>();
  const occurrenceIds = new Set<string>();
  let bytes = 0;
  for (const part of parts) {
    if (!part.references) continue;
    const refs = validateTextReferences(part.text, part.references);
    count += refs.occurrences.length;
    for (const item of refs.occurrences) {
      if (occurrenceIds.has(item.id)) throw new Error("重复的引用位置 ID");
      occurrenceIds.add(item.id);
    }
    refs.targets.forEach((target) => targets.add(referenceKey(target)));
    bytes += new TextEncoder().encode(JSON.stringify(refs)).byteLength;
  }
  if (
    count > REFERENCE_LIMITS.occurrences ||
    targets.size > REFERENCE_LIMITS.targets ||
    bytes > REFERENCE_LIMITS.bytes
  ) {
    throw new Error("每条消息最多 32 处引用、16 个目标及 32 KiB 引用信息");
  }
}

export function projectReferencedText(
  part: ReferencedText,
  registry = referenceTypes,
): string {
  const text =
    part.command && part.commandPrompt !== undefined
      ? `${part.commandPrompt}\n${part.text.slice(0, part.command.start)}${part.text.slice(part.command.end)}`
      : part.text;
  if (!part.references?.occurrences.length) return text;
  const refs = validateTextReferences(part.text, part.references, registry);
  const descriptions = refs.targets.map((target) => ({
    source: target.sourceId,
    type: target.type,
    ...registry.describe(target),
  }));
  return `${text}\n\n[User-provided references; not live database state or authorization]\n${JSON.stringify(descriptions)}`;
}

/** UI metadata is a derived view only; HTTP input carries validated text annotations. */
export function readComposerReferenceMetadata(
  metadata: unknown,
): ReferencedText | null {
  if (!metadata || typeof metadata !== "object") return null;
  const custom = (metadata as { custom?: Record<string, unknown> }).custom;
  const value = custom?.composerReferences;
  if (
    !value ||
    typeof value !== "object" ||
    !("text" in value) ||
    typeof value.text !== "string"
  )
    return null;
  try {
    const references =
      "references" in value && value.references !== undefined
        ? validateTextReferences(value.text, value.references)
        : undefined;
    const command =
      "command" in value && value.command !== undefined
        ? validateCommandBinding(value.text, value.command)
        : undefined;
    const result = {
      text: value.text,
      ...(references ? { references } : {}),
      ...(command ? { command } : {}),
    };
    validateReferenceMessage([result]);
    return result;
  } catch {
    return null;
  }
}

export function combineReferencedTexts(
  parts: readonly ReferencedText[],
): ReferencedText {
  let text = "";
  let command: CommandBinding | undefined;
  const targets = new Map<string, ReferenceTarget>();
  const occurrences: ReferenceOccurrence[] = [];
  for (const [index, part] of parts.entries()) {
    if (index) text += "\n\n";
    const offset = text.length;
    if (part.references) {
      const refs = validateTextReferences(part.text, part.references);
      refs.targets.forEach((target) =>
        targets.set(referenceKey(target), target),
      );
      refs.occurrences.forEach((item, ordinal) =>
        occurrences.push({
          ...item,
          id: parts.length === 1 ? item.id : `${index}:${ordinal}`,
          label:
            item.label ??
            refs.targets.find(
              (target) => referenceKey(target) === item.targetKey,
            )!.label,
          start: item.start + offset,
          end: item.end + offset,
        }),
      );
    }
    if (part.command) {
      if (command) throw new Error("每条消息最多一个消息命令");
      command = {
        ...part.command,
        start: part.command.start + offset,
        end: part.command.end + offset,
      };
    }
    text += part.text;
  }
  return {
    text,
    ...(command ? { command } : {}),
    ...(occurrences.length
      ? {
          references: {
            version: 1 as const,
            targets: [...targets.values()],
            occurrences,
          },
        }
      : {}),
  };
}

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
