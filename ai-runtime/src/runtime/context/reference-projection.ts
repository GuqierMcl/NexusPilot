import {
  type ReferencedText,
  type ReferenceTarget,
  referenceTypes,
  validateTextReferences,
} from "@contracts/composer-references";

export function projectReferencedText(
  part: ReferencedText,
  registry: typeof referenceTypes = referenceTypes,
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
