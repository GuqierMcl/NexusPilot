import type { CommandBinding } from "@contracts/composer-commands";

export interface MessageCommandDefinition {
  id: string;
  version: number;
  name: string;
  prompt: string;
}
export function createMessageCommandRegistry(
  definitions: readonly MessageCommandDefinition[],
) {
  const handlers = new Map<string, Readonly<MessageCommandDefinition>>();
  for (const definition of definitions) {
    const key = `${definition.id}@${definition.version}`;
    if (
      !definition.id ||
      !definition.name ||
      !Number.isSafeInteger(definition.version) ||
      definition.version < 1 ||
      !definition.prompt.trim() ||
      definition.prompt.length > 32768 ||
      handlers.has(key)
    ) {
      throw new Error(`Invalid or duplicate message command: ${key}`);
    }
    handlers.set(key, Object.freeze({ ...definition }));
  }
  return Object.freeze({
    resolve(command: CommandBinding): string {
      const definition = handlers.get(
        `${command.commandId}@${command.version}`,
      );
      if (!definition || definition.name !== command.name)
        throw new Error("不支持的消息命令或版本");
      return definition.prompt;
    },
  });
}
export const messageCommands = createMessageCommandRegistry([
  {
    id: "explain",
    version: 1,
    name: "explain",
    prompt: "请解释以下 SQL 的含义与执行逻辑，并指出需要注意的问题：",
  },
]);
