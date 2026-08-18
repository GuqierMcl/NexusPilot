import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type {
  AnyRuntimeToolDefinition,
  RuntimeToolNamespace,
} from "../src/runtime";
import {
  decodeProviderToolName,
  encodeProviderToolName,
  MAX_PROVIDER_TOOL_NAME_LENGTH,
  parseCanonicalToolId,
  RuntimeToolRegistry,
} from "../src/runtime";

function createTool(
  id: string,
  overrides: Partial<AnyRuntimeToolDefinition> = {},
): AnyRuntimeToolDefinition {
  return {
    id,
    title: id,
    description: `Execute ${id}`,
    inputSchema: z.object({ value: z.string().optional() }).strict(),
    outputSchema: z.object({ value: z.string() }).strict(),
    executionTarget: "runtime",
    risk: {
      mode: "static",
      level: "low",
      reversible: true,
      sideEffect: "none",
    },
    execute: async () => ({ summary: "Done.", data: { value: "ok" } }),
    ...overrides,
  } as AnyRuntimeToolDefinition;
}

function createNamespace(
  id: string,
  tools: readonly AnyRuntimeToolDefinition[],
  overrides: Partial<RuntimeToolNamespace> = {},
): RuntimeToolNamespace {
  return {
    id,
    title: id,
    description: `${id} capability tools`,
    tools,
    resolveForRun: () => ({ candidateToolIds: tools.map((tool) => tool.id) }),
    ...overrides,
  };
}

describe("Provider Tool name codec", () => {
  test("round-trips canonical IDs deterministically", () => {
    expect(encodeProviderToolName("connection.list")).toBe("np__connection__list");
    expect(encodeProviderToolName("metadata.list_children")).toBe(
      "np__metadata__list_children",
    );
    expect(decodeProviderToolName("np__metadata__list_children")).toBe(
      "metadata.list_children",
    );
    expect(parseCanonicalToolId("query.execute")).toEqual({
      namespaceId: "query",
      localName: "execute",
      canonicalId: "query.execute",
    });
  });

  test("rejects malformed, ambiguous, and overlong identities", () => {
    for (const id of [
      "mysql",
      "mysql.query.execute",
      "MySQL.query",
      "mysql.list-tables",
      "mysql._query",
      "mysql.list__tables",
    ]) {
      expect(() => encodeProviderToolName(id)).toThrow();
    }

    expect(() => decodeProviderToolName("connection__list")).toThrow();
    expect(() => decodeProviderToolName("np__connection__list__extra")).toThrow();

    const overlongId = `namespace.${"a".repeat(MAX_PROVIDER_TOOL_NAME_LENGTH)}`;
    expect(() => encodeProviderToolName(overlongId)).toThrow(
      `exceeds ${MAX_PROVIDER_TOOL_NAME_LENGTH} characters`,
    );
  });
});

describe("RuntimeToolRegistry", () => {
  test("indexes immutable Namespaces, Tools, and Provider identities", () => {
    const metadata = { category: "database", tags: ["read"] };
    const capabilities = ["schema_browser"] as const;
    const tool = createTool("metadata.list_children", {
      metadata,
      requiredCapabilities: capabilities,
      limits: { timeoutMs: 5_000, maxResultBytes: 32_768 },
    });
    const namespace = createNamespace("metadata", [tool], {
      metadata: { family: "schema" },
    });
    const registry = new RuntimeToolRegistry([namespace]);

    expect(registry.listNamespaces().map((item) => item.id)).toEqual(["metadata"]);
    expect(registry.listTools().map((item) => item.id)).toEqual([
      "metadata.list_children",
    ]);
    expect(registry.requireNamespace("metadata").tools[0]).toBe(
      registry.requireTool("metadata.list_children"),
    );
    expect(registry.requireProviderName("metadata.list_children")).toBe(
      "np__metadata__list_children",
    );
    expect(registry.requireCanonicalId("np__metadata__list_children")).toBe(
      "metadata.list_children",
    );

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.listNamespaces())).toBe(true);
    expect(Object.isFrozen(registry.listTools())).toBe(true);
    expect(Object.isFrozen(registry.requireNamespace("metadata"))).toBe(true);
    expect(Object.isFrozen(registry.requireNamespace("metadata").tools)).toBe(true);
    expect(Object.isFrozen(registry.requireTool("metadata.list_children"))).toBe(true);
    expect(Object.isFrozen(registry.requireTool("metadata.list_children").risk)).toBe(true);
    expect(
      Object.isFrozen(registry.requireTool("metadata.list_children").metadata),
    ).toBe(true);
    expect(
      Object.isFrozen(
        registry.requireTool("metadata.list_children").requiredCapabilities,
      ),
    ).toBe(true);

    metadata.tags.push("mutated-after-registration");
    expect(registry.requireTool("metadata.list_children").metadata).toEqual({
      category: "database",
      tags: ["read"],
    });
  });

  test("keeps decodable but unregistered Provider names inactive", () => {
    const registry = new RuntimeToolRegistry([
      createNamespace("connection", [createTool("connection.list")]),
    ]);

    expect(decodeProviderToolName("np__connection__get")).toBe("connection.get");
    expect(registry.getCanonicalId("np__connection__get")).toBeNull();
    expect(() => registry.requireCanonicalId("np__connection__get")).toThrow(
      "Unknown or inactive",
    );
  });

  test("rejects duplicate Namespace and Tool identities", () => {
    expect(
      () =>
        new RuntimeToolRegistry([
          createNamespace("connection", [createTool("connection.list")]),
          createNamespace("connection", [createTool("connection.get")]),
        ]),
    ).toThrow('Namespace "connection" is already registered');

    const repeatedTool = createTool("connection.list");
    expect(
      () =>
        new RuntimeToolRegistry([
          createNamespace("connection", [repeatedTool, repeatedTool]),
        ]),
    ).toThrow('Tool "connection.list" is already registered');
  });

  test("rejects invalid Namespace ownership, schemas, metadata, and limits", () => {
    expect(
      () =>
        new RuntimeToolRegistry([
          createNamespace("metadata", [createTool("connection.list")]),
        ]),
    ).toThrow('must belong to Namespace "metadata"');

    expect(
      () =>
        new RuntimeToolRegistry([
          createNamespace("connection", [
            createTool("connection.list", { inputSchema: {} as never }),
          ]),
        ]),
    ).toThrow("inputSchema must be a Zod schema");

    expect(
      () =>
        new RuntimeToolRegistry([
          createNamespace("connection", [
            createTool("connection.list", {
              metadata: { invalidNumber: Number.NaN },
            }),
          ]),
        ]),
    ).toThrow("non-finite number");

    expect(
      () =>
        new RuntimeToolRegistry([
          createNamespace("connection", [
            createTool("connection.list", { limits: { timeoutMs: 0 } }),
          ]),
        ]),
    ).toThrow("timeoutMs must be a positive integer");
  });

  test("enforces static and dynamic Risk definition invariants at startup", () => {
    expect(
      () =>
        new RuntimeToolRegistry([
          createNamespace("query", [
            createTool("query.inspect", {
              resolveRisk: async () => ({
                level: "low",
                reversible: true,
                sideEffects: ["none"],
              }),
            }),
          ]),
        ]),
    ).toThrow("must not define resolveRisk");

    expect(
      () =>
        new RuntimeToolRegistry([
          createNamespace("query", [
            createTool("query.execute", {
              risk: {
                mode: "dynamic",
                level: "low",
                reversible: "conditional",
                sideEffect: "business_read",
              },
              resolveRisk: undefined,
            }),
          ]),
        ]),
    ).toThrow("must define resolveRisk");

    const prepared = createTool("query.execute", {
      executionTarget: "backend",
      risk: {
        mode: "dynamic",
        level: "medium",
        reversible: "conditional",
        sideEffect: "business_write",
      },
      prepare: { operation: "sql.analyze" },
      resolveRisk: undefined,
    });
    expect(
      new RuntimeToolRegistry([
        createNamespace("query", [prepared]),
      ]).requireTool("query.execute").prepare,
    ).toEqual({ operation: "sql.analyze" });

    expect(
      () =>
        new RuntimeToolRegistry([
          createNamespace("query", [
            createTool("query.execute", {
              executionTarget: "runtime",
              risk: {
                mode: "dynamic",
                level: "medium",
                reversible: "conditional",
                sideEffect: "business_write",
              },
              prepare: { operation: "sql.analyze" },
              resolveRisk: undefined,
            }),
          ]),
        ]),
    ).toThrow("must declare one trusted Backend prepare operation");
  });
});
