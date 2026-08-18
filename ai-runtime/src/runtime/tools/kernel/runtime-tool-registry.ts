import type { JsonObject, JsonValue } from "../contracts";
import {
  TOOL_RISK_LEVELS,
  TOOL_SIDE_EFFECTS,
  type AnyRuntimeToolDefinition,
  type DomainCapabilityId,
} from "../contracts";
import type { RuntimeToolNamespace } from "./namespace";
import {
  assertNamespaceId,
  decodeProviderToolName,
  encodeProviderToolName,
  parseCanonicalToolId,
} from "./provider-name-codec";

const DOMAIN_CAPABILITIES = new Set<DomainCapabilityId>([
  "schema_browser",
  "data_table_browser",
  "key_value_browser",
  "sql_executor",
]);

export class RuntimeToolRegistry {
  readonly #namespaces: readonly RuntimeToolNamespace[];
  readonly #tools: readonly AnyRuntimeToolDefinition[];
  readonly #namespaceById: ReadonlyMap<string, RuntimeToolNamespace>;
  readonly #toolById: ReadonlyMap<string, AnyRuntimeToolDefinition>;
  readonly #providerNameByToolId: ReadonlyMap<string, string>;
  readonly #toolIdByProviderName: ReadonlyMap<string, string>;

  constructor(namespaces: readonly RuntimeToolNamespace[]) {
    const namespaceById = new Map<string, RuntimeToolNamespace>();
    const toolById = new Map<string, AnyRuntimeToolDefinition>();
    const providerNameByToolId = new Map<string, string>();
    const toolIdByProviderName = new Map<string, string>();
    const frozenNamespaces: RuntimeToolNamespace[] = [];

    for (const namespace of namespaces) {
      validateNamespace(namespace);
      if (namespaceById.has(namespace.id)) {
        throw new Error(`Namespace "${namespace.id}" is already registered`);
      }

      const frozenTools: AnyRuntimeToolDefinition[] = [];
      for (const tool of namespace.tools) {
        validateToolDefinition(namespace.id, tool);
        if (toolById.has(tool.id)) {
          throw new Error(`Tool "${tool.id}" is already registered`);
        }

        const providerName = encodeProviderToolName(tool.id);
        const conflictingToolId = toolIdByProviderName.get(providerName);
        if (conflictingToolId) {
          throw new Error(
            `Provider Tool name "${providerName}" conflicts between "${conflictingToolId}" and "${tool.id}"`,
          );
        }

        const frozenTool = freezeToolDefinition(tool);
        frozenTools.push(frozenTool);
        toolById.set(frozenTool.id, frozenTool);
        providerNameByToolId.set(frozenTool.id, providerName);
        toolIdByProviderName.set(providerName, frozenTool.id);
      }

      const frozenNamespace = Object.freeze({
        ...namespace,
        ...(namespace.metadata
          ? { metadata: freezeJsonObject(namespace.metadata) }
          : {}),
        tools: Object.freeze(frozenTools),
      });
      frozenNamespaces.push(frozenNamespace);
      namespaceById.set(frozenNamespace.id, frozenNamespace);
    }

    this.#namespaces = Object.freeze(frozenNamespaces);
    this.#tools = Object.freeze([...toolById.values()]);
    this.#namespaceById = namespaceById;
    this.#toolById = toolById;
    this.#providerNameByToolId = providerNameByToolId;
    this.#toolIdByProviderName = toolIdByProviderName;
    Object.freeze(this);
  }

  listNamespaces(): readonly RuntimeToolNamespace[] {
    return this.#namespaces;
  }

  getNamespace(namespaceId: string): RuntimeToolNamespace | null {
    return this.#namespaceById.get(namespaceId) ?? null;
  }

  requireNamespace(namespaceId: string): RuntimeToolNamespace {
    const namespace = this.getNamespace(namespaceId);
    if (!namespace) {
      throw new Error(`Unknown Runtime Tool Namespace "${namespaceId}"`);
    }
    return namespace;
  }

  listTools(): readonly AnyRuntimeToolDefinition[] {
    return this.#tools;
  }

  getTool(canonicalId: string): AnyRuntimeToolDefinition | null {
    return this.#toolById.get(canonicalId) ?? null;
  }

  requireTool(canonicalId: string): AnyRuntimeToolDefinition {
    const tool = this.getTool(canonicalId);
    if (!tool) {
      throw new Error(`Unknown Runtime Tool "${canonicalId}"`);
    }
    return tool;
  }

  getProviderName(canonicalId: string): string | null {
    return this.#providerNameByToolId.get(canonicalId) ?? null;
  }

  requireProviderName(canonicalId: string): string {
    const providerName = this.getProviderName(canonicalId);
    if (!providerName) {
      throw new Error(`Unknown Runtime Tool "${canonicalId}"`);
    }
    return providerName;
  }

  getCanonicalId(providerName: string): string | null {
    return this.#toolIdByProviderName.get(providerName) ?? null;
  }

  requireCanonicalId(providerName: string): string {
    const canonicalId = this.getCanonicalId(providerName);
    if (!canonicalId) {
      throw new Error(`Unknown or inactive Provider Tool name "${providerName}"`);
    }
    return canonicalId;
  }
}

function validateNamespace(namespace: RuntimeToolNamespace): void {
  assertNamespaceId(namespace.id);
  assertNonEmptyText(namespace.title, `Namespace "${namespace.id}" title`);
  assertNonEmptyText(namespace.description, `Namespace "${namespace.id}" description`);
  if (typeof namespace.resolveForRun !== "function") {
    throw new Error(`Namespace "${namespace.id}" must define resolveForRun`);
  }
  if (!Array.isArray(namespace.tools)) {
    throw new Error(`Namespace "${namespace.id}" tools must be an array`);
  }
  if (namespace.metadata) {
    validateJsonObject(namespace.metadata, `Namespace "${namespace.id}" metadata`);
  }
}

function validateToolDefinition(
  namespaceId: string,
  tool: AnyRuntimeToolDefinition,
): void {
  const identity = parseCanonicalToolId(tool.id);
  if (identity.namespaceId !== namespaceId) {
    throw new Error(
      `Tool "${tool.id}" must belong to Namespace "${namespaceId}"`,
    );
  }

  assertNonEmptyText(tool.title, `Tool "${tool.id}" title`);
  assertNonEmptyText(tool.description, `Tool "${tool.id}" description`);
  assertSchema(tool.inputSchema, `Tool "${tool.id}" inputSchema`);
  assertSchema(tool.outputSchema, `Tool "${tool.id}" outputSchema`);

  if (tool.executionTarget !== "runtime" && tool.executionTarget !== "backend") {
    throw new Error(`Tool "${tool.id}" has an invalid execution target`);
  }
  if (!TOOL_RISK_LEVELS.includes(tool.risk.level)) {
    throw new Error(`Tool "${tool.id}" has an invalid risk level`);
  }
  if (!TOOL_SIDE_EFFECTS.includes(tool.risk.sideEffect)) {
    throw new Error(`Tool "${tool.id}" has an invalid side effect`);
  }
  if (tool.risk.mode === "static") {
    if (
      typeof tool.risk.reversible !== "boolean" ||
      tool.resolveRisk !== undefined ||
      tool.prepare !== undefined
    ) {
      throw new Error(`Static Tool "${tool.id}" must not define resolveRisk`);
    }
  } else if (tool.risk.mode === "dynamic") {
    if (tool.prepare) {
      if (
        tool.executionTarget !== "backend" ||
        typeof tool.prepare.operation !== "string" ||
        !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(tool.prepare.operation) ||
        tool.resolveRisk !== undefined ||
        tool.describePermission !== undefined
      ) {
        throw new Error(
          `Prepared Tool "${tool.id}" must declare one trusted Backend prepare operation`,
        );
      }
    } else if (typeof tool.resolveRisk !== "function") {
      throw new Error(`Dynamic Tool "${tool.id}" must define resolveRisk`);
    }
  } else {
    throw new Error(`Tool "${tool.id}" has an invalid risk mode`);
  }

  if (typeof tool.execute !== "function") {
    throw new Error(`Tool "${tool.id}" must define execute`);
  }
  if (tool.metadata) {
    validateJsonObject(tool.metadata, `Tool "${tool.id}" metadata`);
  }
  if (tool.requiredCapabilities) {
    const capabilities = new Set<DomainCapabilityId>();
    for (const capability of tool.requiredCapabilities) {
      if (!DOMAIN_CAPABILITIES.has(capability)) {
        throw new Error(`Tool "${tool.id}" requires unknown capability "${capability}"`);
      }
      if (capabilities.has(capability)) {
        throw new Error(`Tool "${tool.id}" repeats capability "${capability}"`);
      }
      capabilities.add(capability);
    }
  }
  if (tool.limits?.timeoutMs !== undefined) {
    assertPositiveInteger(tool.limits.timeoutMs, `Tool "${tool.id}" timeoutMs`);
  }
  if (tool.limits?.maxResultBytes !== undefined) {
    assertPositiveInteger(tool.limits.maxResultBytes, `Tool "${tool.id}" maxResultBytes`);
  }

  const providerName = encodeProviderToolName(tool.id);
  if (decodeProviderToolName(providerName) !== tool.id) {
    throw new Error(`Tool "${tool.id}" Provider name is not reversible`);
  }
}

function freezeToolDefinition(tool: AnyRuntimeToolDefinition): AnyRuntimeToolDefinition {
  return Object.freeze({
    ...tool,
    risk: Object.freeze({ ...tool.risk }),
    ...(tool.metadata ? { metadata: freezeJsonObject(tool.metadata) } : {}),
    ...(tool.requiredCapabilities
      ? { requiredCapabilities: Object.freeze([...tool.requiredCapabilities]) }
      : {}),
    ...(tool.limits ? { limits: Object.freeze({ ...tool.limits }) } : {}),
  }) as AnyRuntimeToolDefinition;
}

function assertSchema(schema: unknown, label: string): void {
  if (
    typeof schema !== "object" ||
    schema === null ||
    typeof (schema as { safeParse?: unknown }).safeParse !== "function"
  ) {
    throw new Error(`${label} must be a Zod schema`);
  }
}

function assertNonEmptyText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function validateJsonObject(value: JsonObject, label: string): void {
  validateJsonValue(value, label, new Set<object>());
}

function validateJsonValue(value: JsonValue, label: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} contains a non-JSON value`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} contains a circular reference`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      validateJsonValue(item, label, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} contains a non-plain object`);
    }
    for (const item of Object.values(value)) {
      validateJsonValue(item, label, ancestors);
    }
  }
  ancestors.delete(value);
}

function freezeJsonObject(value: JsonObject): JsonObject {
  return deepFreezeJson(value) as JsonObject;
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreezeJson)) as unknown as JsonValue;
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, deepFreezeJson(item)]),
    ),
  ) as JsonValue;
}
