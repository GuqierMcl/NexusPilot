import { type ReferenceTarget } from "../../../../../shared/composer-references";

export interface SourceCandidate {
  id: string;
  label: string;
  description: string;
  target: ReferenceTarget;
}
export type SourceAvailability =
  | { available: true }
  | { available: false; reason: string };
export interface ContextSource {
  id: string;
  title: string;
  description: string;
  icon: string;
  order: number;
  refresh?: () => Promise<void>;
  availability: () => SourceAvailability;
  search: (
    query: string,
    limit: number,
    signal: AbortSignal,
  ) => Promise<readonly SourceCandidate[]>;
  capture: (candidate: SourceCandidate) => ReferenceTarget;
  validate: (target: ReferenceTarget) => SourceAvailability;
}
export type CommandAction =
  | { kind: "template"; text: string }
  | { kind: "help" }
  | { kind: "message"; version: number }
  | { kind: "operation"; version: number; operation: "compact" };
export interface ComposerCommand {
  id: string;
  name: string;
  title: string;
  description: string;
  aliases: readonly string[];
  availability: () => SourceAvailability;
  action: () => CommandAction;
}

export function createSourceRegistry(definitions: readonly ContextSource[]) {
  const map = new Map<string, Readonly<ContextSource>>();
  for (const definition of definitions) {
    if (
      !definition.id.trim() ||
      !definition.title.trim() ||
      !definition.description.trim() ||
      !definition.icon.trim() ||
      !Number.isFinite(definition.order) ||
      [
        definition.availability,
        definition.search,
        definition.capture,
        definition.validate,
      ].some((fn) => typeof fn !== "function") ||
      map.has(definition.id)
    )
      throw new Error(`Duplicate or invalid context source: ${definition.id}`);
    map.set(definition.id, Object.freeze({ ...definition }));
  }
  return Object.freeze({
    list: Object.freeze(
      [...map.values()].sort(
        (a, b) => a.order - b.order || a.id.localeCompare(b.id),
      ),
    ),
    get: (id: string) => map.get(id),
    validate: (target: ReferenceTarget): SourceAvailability =>
      map.get(target.sourceId)?.validate(target) ?? {
        available: false,
        reason: "该引用来源当前不可用",
      },
  });
}
export type SourceRegistry = ReturnType<typeof createSourceRegistry>;

export function createCommandRegistry(definitions: readonly ComposerCommand[]) {
  const ids = new Set<string>();
  const names = new Set<string>();
  const commands = definitions.map((definition) => {
    if (
      !definition.id.trim() ||
      !definition.title.trim() ||
      !definition.description.trim() ||
      typeof definition.availability !== "function" ||
      typeof definition.action !== "function" ||
      ids.has(definition.id)
    )
      throw new Error(`Duplicate or invalid command: ${definition.id}`);
    ids.add(definition.id);
    for (const alias of [definition.name, ...definition.aliases]) {
      const key = alias.trim().toLowerCase();
      if (!key || names.has(key))
        throw new Error(`Duplicate command name or alias: ${alias}`);
      names.add(key);
    }
    return Object.freeze({
      ...definition,
      aliases: Object.freeze([...definition.aliases]),
    });
  });
  return Object.freeze({
    list: Object.freeze(commands),
    get: (id: string) => commands.find((command) => command.id === id),
    search: (query: string) =>
      commands.filter(
        (command) =>
          command.availability().available &&
          [
            command.name,
            command.title,
            command.description,
            ...command.aliases,
          ].some((value) => value.toLowerCase().includes(query.toLowerCase())),
      ),
  });
}
export type CommandRegistry = ReturnType<typeof createCommandRegistry>;
export interface SourceSearchGroup {
  sourceId: string;
  title: string;
  candidates: readonly SourceCandidate[];
  error?: string;
}

export async function searchSources(
  registry: SourceRegistry,
  query: string,
  signal: AbortSignal,
): Promise<SourceSearchGroup[]> {
  const results = await Promise.all(
    registry.list.map(async (source): Promise<SourceSearchGroup> => {
      const base = { sourceId: source.id, title: source.title };
      try {
        const status = source.availability();
        if (!status.available)
          return { ...base, candidates: [], error: status.reason };
        const candidates = await source.search(query, 20, signal);
        return { ...base, candidates: candidates.slice(0, 20) };
      } catch (error) {
        if (!signal.aborted)
          console.error("[composer] source search failed", {
            source: source.id,
            error,
          });
        return {
          ...base,
          candidates: [],
          error: "来源搜索失败，请重试",
        };
      }
    }),
  );
  return signal.aborted ? [] : results;
}

export function validateDraftTargets(
  registry: SourceRegistry,
  targets: readonly ReferenceTarget[],
): string[] {
  return targets.flatMap((target) => {
    const status = registry.validate(target);
    return status.available ? [] : [`${target.label}: ${status.reason}`];
  });
}
