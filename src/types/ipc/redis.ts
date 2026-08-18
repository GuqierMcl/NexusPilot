export interface RedisScanRequest {
    dbIndex: number;
    pattern: string;
    cursor: number;
    count: number;
}

export interface RedisKeyRef {
    dbIndex: number;
    key: string;
}

export interface RedisKeyInfo {
    key: string;
    valueType: string;
    ttl: number;
    size?: number | null;
}

export interface RedisScanResult {
    cursor: number;
    keys: RedisKeyInfo[];
}

export interface RedisKeyTreeRequest {
    dbIndex: number;
    pattern: string;
    count: number;
}

export type RedisKeyTreeNodeKind = "prefix" | "key";

export interface RedisKeyTreeNode {
    id: string;
    label: string;
    nodeType: RedisKeyTreeNodeKind;
    prefix?: string | null;
    pattern?: string | null;
    key?: string | null;
    keyCount: number;
    valueType?: string | null;
    children: RedisKeyTreeNode[];
}

export interface RedisKeyTreeResult {
    dbIndex: number;
    pattern: string;
    totalKeyCount: number;
    nodes: RedisKeyTreeNode[];
}

export interface RedisHashEntry {
    field: string;
    value: string;
}

export interface RedisSortedSetEntry {
    member: string;
    score: number;
}

export interface RedisStreamEntry {
    id: string;
    fields: RedisHashEntry[];
}

export type RedisStringValue =
    | { encoding: "utf8"; value: string | null }
    | { encoding: "binary"; byteLength: number; previewHex: string };

export type RedisValue =
    | { kind: "string"; value: RedisStringValue }
    | { kind: "json"; value: string }
    | { kind: "hash"; value: RedisHashEntry[] }
    | { kind: "list"; value: string[] }
    | { kind: "set"; value: string[] }
    | { kind: "sorted_set"; value: RedisSortedSetEntry[] }
    | { kind: "stream"; value: RedisStreamEntry[] }
    | { kind: "unsupported"; value: string };

export interface RedisKeyValue {
    key: string;
    valueType: string;
    ttl: number;
    size?: number | null;
    fingerprint: string;
    value: RedisValue;
}

export type RedisTtlPolicy = "keep" | "persist" | "expire";

export type RedisEditableValue =
    | { kind: "string"; value: string }
    | { kind: "json"; value: string }
    | { kind: "hash"; value: RedisHashEntry[] }
    | { kind: "list"; value: string[] }
    | { kind: "set"; value: string[] }
    | { kind: "sorted_set"; value: RedisSortedSetEntry[] }
    | { kind: "stream"; value: RedisStreamEntry[] };

export interface RedisSetKeyValueRequest {
    dbIndex: number;
    key: string;
    value: RedisEditableValue;
    expectedFingerprint: string;
    expectedType?: string | null;
    ttlPolicy?: RedisTtlPolicy | null;
    ttlSeconds?: number | null;
}

export interface RedisCreateKeyValueRequest {
    dbIndex: number;
    key: string;
    value: RedisEditableValue;
    ttlPolicy?: RedisTtlPolicy | null;
    ttlSeconds?: number | null;
}

export interface RedisDeleteKeyRequest {
    dbIndex: number;
    key: string;
    expectedFingerprint: string;
}

export interface RedisDeleteKeyPrefixRequest {
    dbIndex: number;
    pattern: string;
}

export interface RedisRenameKeyRequest {
    dbIndex: number;
    key: string;
    newKey: string;
    expectedFingerprint: string;
}

export type RedisSetKeyTtlMode = "expire" | "persist";

export interface RedisSetKeyTtlRequest {
    dbIndex: number;
    key: string;
    expectedFingerprint: string;
    mode: RedisSetKeyTtlMode;
    ttlSeconds?: number | null;
}

export interface RedisKeyMutationResult {
    dbIndex: number;
    key: string;
    valueType: string;
    ttl: number;
    size?: number | null;
    fingerprint: string;
}

export interface RedisDeleteKeyResult {
    dbIndex: number;
    key?: string | null;
    pattern?: string | null;
    deletedCount: number;
}
