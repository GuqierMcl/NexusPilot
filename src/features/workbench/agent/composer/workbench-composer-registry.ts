import {
  createCommandRegistry,
  createSourceRegistry,
  type ContextSource,
  type SourceAvailability,
} from "./composer-registry";

export interface ConnectionDirectory {
  connections: readonly { id: string; name: string; driver: string }[];
  isLoading: boolean;
  error: string | null;
  refresh?: () => Promise<void>;
}
export function createConnectionSource(
  getDirectory: () => ConnectionDirectory,
): ContextSource {
  const availability = (): SourceAvailability => {
    const directory = getDirectory();
    if (directory.isLoading)
      return { available: false, reason: "正在加载连接目录" };
    if (directory.error)
      return { available: false, reason: "连接目录加载失败，请重试" };
    return { available: true };
  };
  return {
    id: "connections",
    title: "数据库连接",
    description: "引用已保存的连接名称与驱动",
    icon: "database",
    order: 0,
    availability,
    refresh: async () => {
      await getDirectory().refresh?.();
    },
    async search(query, limit, signal) {
      if (signal.aborted) return [];
      return getDirectory()
        .connections.filter((connection) =>
          [connection.name, connection.driver, connection.id].some((value) =>
            value.toLowerCase().includes(query.toLowerCase()),
          ),
        )
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map((connection) => ({
          id: connection.id,
          label: connection.name,
          description: `${connection.driver} · ${connection.id}`,
          target: {
            sourceId: "connections",
            type: "connection",
            version: 1,
            id: connection.id,
            label: connection.name,
            data: { driver: connection.driver },
          },
        }));
    },
    capture: (candidate) => ({
      ...candidate.target,
      data: { ...candidate.target.data },
    }),
    validate: (target) => {
      const status = availability();
      if (!status.available) return status;
      return getDirectory().connections.some(
        (connection) => connection.id === target.id,
      )
        ? { available: true }
        : {
            available: false,
            reason: "连接已删除，请移除引用或转为普通文本",
          };
    },
  };
}
export function createWorkbenchComposerRegistry(
  getDirectory: () => ConnectionDirectory,
) {
  return Object.freeze({
    sources: createSourceRegistry([createConnectionSource(getDirectory)]),
    commands: createCommandRegistry([
      {
        id: "compact",
        name: "compact",
        title: "压缩上下文",
        description: "发送后压缩当前会话，保留原始历史",
        aliases: ["压缩"],
        availability: () => ({ available: true }),
        action: () => ({ kind: "operation", version: 1, operation: "compact" }),
      },
      {
        id: "help",
        name: "help",
        title: "帮助",
        description: "查看可用命令与引用说明",
        aliases: ["帮助"],
        availability: () => ({ available: true }),
        action: () => ({ kind: "help" }),
      },
      {
        id: "explain",
        name: "explain",
        title: "解释 SQL",
        description: "准备 SQL 解释问题，不执行查询",
        aliases: ["解释"],
        availability: () => ({ available: true }),
        action: () => ({
          kind: "message",
          version: 1,
        }),
      },
    ]),
  });
}
