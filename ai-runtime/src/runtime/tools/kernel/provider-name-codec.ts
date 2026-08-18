const CANONICAL_SEGMENT_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const PROVIDER_PREFIX = "np__";
const PROVIDER_SEPARATOR = "__";

export const MAX_PROVIDER_TOOL_NAME_LENGTH = 64;

export interface CanonicalToolIdentity {
  namespaceId: string;
  localName: string;
  canonicalId: string;
}

export function parseCanonicalToolId(canonicalId: string): CanonicalToolIdentity {
  const segments = canonicalId.split(".");
  if (segments.length !== 2) {
    throw new Error(
      `Invalid canonical Tool ID "${canonicalId}": expected exactly namespace.tool`,
    );
  }

  const [namespaceId, localName] = segments;
  assertCanonicalSegment(namespaceId, "namespace");
  assertCanonicalSegment(localName, "tool");

  const providerName = `${PROVIDER_PREFIX}${namespaceId}${PROVIDER_SEPARATOR}${localName}`;
  if (providerName.length > MAX_PROVIDER_TOOL_NAME_LENGTH) {
    throw new Error(
      `Invalid canonical Tool ID "${canonicalId}": encoded Provider name exceeds ${MAX_PROVIDER_TOOL_NAME_LENGTH} characters`,
    );
  }

  return { namespaceId, localName, canonicalId };
}

export function encodeProviderToolName(canonicalId: string): string {
  const identity = parseCanonicalToolId(canonicalId);
  return `${PROVIDER_PREFIX}${identity.namespaceId}${PROVIDER_SEPARATOR}${identity.localName}`;
}

export function decodeProviderToolName(providerName: string): string {
  if (
    providerName.length > MAX_PROVIDER_TOOL_NAME_LENGTH ||
    !providerName.startsWith(PROVIDER_PREFIX)
  ) {
    throw new Error(`Invalid Provider Tool name "${providerName}"`);
  }

  const encodedIdentity = providerName.slice(PROVIDER_PREFIX.length);
  const segments = encodedIdentity.split(PROVIDER_SEPARATOR);
  if (segments.length !== 2) {
    throw new Error(`Invalid Provider Tool name "${providerName}"`);
  }

  const canonicalId = `${segments[0]}.${segments[1]}`;
  const identity = parseCanonicalToolId(canonicalId);
  if (encodeProviderToolName(identity.canonicalId) !== providerName) {
    throw new Error(`Invalid Provider Tool name "${providerName}"`);
  }

  return identity.canonicalId;
}

export function assertNamespaceId(namespaceId: string): void {
  assertCanonicalSegment(namespaceId, "namespace");
}

function assertCanonicalSegment(segment: string, kind: "namespace" | "tool"): void {
  if (!CANONICAL_SEGMENT_PATTERN.test(segment)) {
    throw new Error(
      `Invalid ${kind} segment "${segment}": expected lower_snake_case without consecutive underscores`,
    );
  }
}
