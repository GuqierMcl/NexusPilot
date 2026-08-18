import type {
    KeyValueCreateDraft,
    KeyValueEditableDraftValue,
    KeyValueRuntimeState,
} from "@/store";
import type { RedisKeyTreeNode, RedisValue } from "@/types/ipc";
import {
    formatJsonContent,
    formatStringPreviewContent,
    type StringPreviewMode,
} from "../redis-value-preview";

export function formatTtl(ttl: number): string {
    return String(ttl);
}

export function formatMemoryUsage(size?: number | null): string {
    if (size == null) return "unknown";
    if (size < 1024) return `${size} B`;

    const units = ["KB", "MB", "GB", "TB"] as const;
    let value = size / 1024;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

export function getRedisTypeBadgeClass(valueType?: string): string {
    switch (valueType) {
        case "string":
            return "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:text-sky-300";
        case "json":
            return "border-lime-500/30 bg-lime-500/15 text-lime-700 dark:text-lime-300";
        case "hash":
            return "border-violet-500/30 bg-violet-500/15 text-violet-700 dark:text-violet-300";
        case "list":
            return "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
        case "set":
            return "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300";
        case "zset":
            return "border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-300";
        case "stream":
            return "border-orange-500/30 bg-orange-500/15 text-orange-700 dark:text-orange-300";
        case "unsupported":
            return "border-muted-foreground/30 bg-muted text-muted-foreground";
        default:
            return "border-border bg-muted text-muted-foreground";
    }
}

export function collectPrefixIds(nodes: RedisKeyTreeNode[]): string[] {
    const ids: string[] = [];

    function visit(node: RedisKeyTreeNode) {
        if (node.nodeType === "prefix") {
            ids.push(node.id);
        }
        node.children.forEach(visit);
    }

    nodes.forEach(visit);
    return ids;
}

export function cloneEditableValue(value: KeyValueEditableDraftValue): KeyValueEditableDraftValue {
    return JSON.parse(JSON.stringify(value)) as KeyValueEditableDraftValue;
}

export function stableEditableValue(value: KeyValueEditableDraftValue): string {
    return JSON.stringify(value);
}

export function createDefaultEditableValue(
    kind: KeyValueEditableDraftValue["kind"],
): KeyValueEditableDraftValue {
    switch (kind) {
        case "string":
            return { kind: "string", value: "" };
        case "json":
            return { kind: "json", value: "{}" };
        case "hash":
            return { kind: "hash", value: [{ field: "", value: "" }] };
        case "list":
            return { kind: "list", value: [""] };
        case "set":
            return { kind: "set", value: [""] };
        case "sorted_set":
            return { kind: "sorted_set", value: [{ score: 0, member: "" }] };
        case "stream":
            return {
                kind: "stream",
                value: [{ id: "*", fields: [{ field: "", value: "" }] }],
            };
    }
}

export function createDefaultCreateDraft(
    kind: KeyValueEditableDraftValue["kind"] = "string",
): KeyValueCreateDraft {
    return {
        keyDraft: "",
        valueKind: kind,
        valueDraft: createDefaultEditableValue(kind),
        ttlSecondsDraft: "",
    };
}

export function redisValueFromEditableValue(value: KeyValueEditableDraftValue): RedisValue {
    switch (value.kind) {
        case "string":
            return {
                kind: "string",
                value: { encoding: "utf8", value: value.value },
            };
        case "json":
            return { kind: "json", value: value.value };
        case "hash":
            return { kind: "hash", value: value.value };
        case "list":
            return { kind: "list", value: value.value };
        case "set":
            return { kind: "set", value: value.value };
        case "sorted_set":
            return { kind: "sorted_set", value: value.value };
        case "stream":
            return { kind: "stream", value: value.value };
    }
}

export function displayTypeForEditableValue(value: KeyValueEditableDraftValue): string {
    return value.kind === "sorted_set" ? "zset" : value.kind;
}

export function formatCreateTtlLabel(draft: KeyValueCreateDraft | null): string {
    const ttl = draft?.ttlSecondsDraft.trim();
    return `TTL ${ttl ? ttl : "-1"}`;
}

export function isCreateDraftDirty(draft: KeyValueCreateDraft | null): boolean {
    if (!draft) return false;
    const baseline = createDefaultCreateDraft();

    return (
        draft.keyDraft !== baseline.keyDraft ||
        draft.valueKind !== baseline.valueKind ||
        draft.ttlSecondsDraft !== baseline.ttlSecondsDraft ||
        stableEditableValue(draft.valueDraft) !==
            stableEditableValue(baseline.valueDraft)
    );
}

export function createEditableDraft({
    key,
    fingerprint,
    value,
    mode,
}: {
    key: string;
    fingerprint: string;
    value: RedisValue;
    mode: StringPreviewMode;
}): KeyValueRuntimeState["valueDraft"] {
    const editableValue = toEditableDraftValue(value, mode);
    if (!editableValue) return null;

    return {
        sourceKey: key,
        baseKey: key,
        keyDraft: key,
        baselineFingerprint: fingerprint,
        valueKind: editableValue.kind,
        baseValue: cloneEditableValue(editableValue),
        valueDraft: cloneEditableValue(editableValue),
    };
}

export function toEditableDraftValue(
    value: RedisValue,
    mode: StringPreviewMode,
): KeyValueEditableDraftValue | null {
    switch (value.kind) {
        case "string": {
            if (value.value.encoding !== "utf8") return null;
            return {
                kind: "string",
                value: formatStringPreviewContent(value.value.value ?? "", mode).content,
            };
        }
        case "json":
            try {
                return { kind: "json", value: formatJsonContent(value.value) };
            } catch {
                return { kind: "json", value: value.value };
            }
        case "hash":
            return { kind: "hash", value: value.value.map((entry) => ({ ...entry })) };
        case "list":
            return { kind: "list", value: [...value.value] };
        case "set":
            return { kind: "set", value: [...value.value] };
        case "sorted_set":
            return {
                kind: "sorted_set",
                value: value.value.map((entry) => ({ ...entry })),
            };
        case "stream":
            return {
                kind: "stream",
                value: value.value.map((entry) => ({
                    id: entry.id,
                    fields: entry.fields.map((field) => ({ ...field })),
                })),
            };
        case "unsupported":
        default:
            return null;
    }
}

export function expectedTypeForEditableValue(value: KeyValueEditableDraftValue): string {
    return value.kind === "sorted_set" ? "zset" : value.kind;
}

export function duplicateValues(values: string[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();

    values.forEach((value) => {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
    });

    return [...duplicates];
}

export function validateEditableKeyAndValue(
    keyDraft: string,
    value: KeyValueEditableDraftValue,
): string | null {
    if (keyDraft.trim().length === 0) {
        return "Key 名不能为空";
    }

    switch (value.kind) {
        case "string":
            return null;
        case "json":
            try {
                JSON.parse(value.value);
                return null;
            } catch {
                return "JSON 内容不是有效格式";
            }
        case "hash": {
            if (value.value.length === 0) return "Hash 至少需要保留一个 field";
            const fields = value.value.map((entry) => entry.field);
            if (fields.some((field) => field.trim().length === 0)) {
                return "Hash field 不能为空";
            }
            const duplicates = duplicateValues(fields);
            return duplicates.length > 0
                ? `Hash field 不能重复：${duplicates[0]}`
                : null;
        }
        case "list":
            return value.value.length === 0 ? "List 至少需要保留一个元素" : null;
        case "set": {
            if (value.value.length === 0) return "Set 至少需要保留一个 member";
            if (value.value.some((member) => member.trim().length === 0)) {
                return "Set member 不能为空";
            }
            const duplicates = duplicateValues(value.value);
            return duplicates.length > 0
                ? `Set member 不能重复：${duplicates[0]}`
                : null;
        }
        case "sorted_set": {
            if (value.value.length === 0) return "Sorted set 至少需要保留一个 member";
            if (value.value.some((entry) => entry.member.trim().length === 0)) {
                return "Sorted set member 不能为空";
            }
            if (value.value.some((entry) => !Number.isFinite(entry.score))) {
                return "Sorted set score 必须是有效数字";
            }
            const duplicates = duplicateValues(value.value.map((entry) => entry.member));
            return duplicates.length > 0
                ? `Sorted set member 不能重复：${duplicates[0]}`
                : null;
        }
        case "stream": {
            if (value.value.length === 0) return "Stream 至少需要保留一个 entry";
            const explicitIds = value.value
                .map((entry) => entry.id.trim())
                .filter((id) => id.length > 0 && id !== "*");
            const duplicateIds = duplicateValues(explicitIds);

            if (value.value.some((entry) => entry.id.trim().length === 0)) {
                return "Stream entry ID 不能为空";
            }
            if (duplicateIds.length > 0) {
                return `Stream entry ID 不能重复：${duplicateIds[0]}`;
            }

            for (const entry of value.value) {
                if (entry.fields.length === 0) {
                    return "Stream entry 至少需要保留一个 field";
                }
                const fields = entry.fields.map((field) => field.field);
                if (fields.some((field) => field.trim().length === 0)) {
                    return "Stream field 不能为空";
                }
                const duplicateFields = duplicateValues(fields);
                if (duplicateFields.length > 0) {
                    return `Stream 同一 entry 内 field 不能重复：${duplicateFields[0]}`;
                }
            }

            return null;
        }
    }
}

export function validateEditableDraft(
    draft: KeyValueRuntimeState["valueDraft"],
): string | null {
    if (!draft) return null;
    return validateEditableKeyAndValue(draft.keyDraft, draft.valueDraft);
}

export function validateCreateDraft(draft: KeyValueCreateDraft | null): string | null {
    if (!draft) return null;

    const valueError = validateEditableKeyAndValue(
        draft.keyDraft,
        draft.valueDraft,
    );
    if (valueError) return valueError;

    const ttl = draft.ttlSecondsDraft.trim();
    if (
        ttl.length > 0 &&
        (!Number.isInteger(Number(ttl)) || Number(ttl) <= 0)
    ) {
        return "TTL 必须是正整数秒数";
    }

    return null;
}

export type EditableCollectionValue = Extract<
    KeyValueEditableDraftValue,
    { kind: "hash" | "list" | "set" | "sorted_set" | "stream" }
>;

export function isEditableCollectionValue(
    value: KeyValueEditableDraftValue | null | undefined,
): value is EditableCollectionValue {
    return (
        value?.kind === "hash" ||
        value?.kind === "list" ||
        value?.kind === "set" ||
        value?.kind === "sorted_set" ||
        value?.kind === "stream"
    );
}

export function getCollectionLength(value: EditableCollectionValue): number {
    if (value.kind === "stream") {
        return value.value.reduce((total, entry) => total + entry.fields.length, 0);
    }
    return value.value.length;
}

export function appendCollectionRow(value: EditableCollectionValue): EditableCollectionValue {
    switch (value.kind) {
        case "hash":
            return { kind: "hash", value: [...value.value, { field: "", value: "" }] };
        case "list":
            return { kind: "list", value: [...value.value, ""] };
        case "set":
            return { kind: "set", value: [...value.value, ""] };
        case "sorted_set":
            return {
                kind: "sorted_set",
                value: [...value.value, { score: 0, member: "" }],
            };
        case "stream":
            return {
                kind: "stream",
                value: [
                    ...value.value,
                    { id: "*", fields: [{ field: "", value: "" }] },
                ],
            };
    }
}

export function resolveStreamFieldIndex(
    value: Extract<EditableCollectionValue, { kind: "stream" }>,
    rowIndex: number,
): { entryIndex: number; fieldIndex: number } | null {
    let currentRowIndex = 0;

    for (let entryIndex = 0; entryIndex < value.value.length; entryIndex += 1) {
        const entry = value.value[entryIndex];
        for (let fieldIndex = 0; fieldIndex < entry.fields.length; fieldIndex += 1) {
            if (currentRowIndex === rowIndex) return { entryIndex, fieldIndex };
            currentRowIndex += 1;
        }
    }

    return null;
}

export function deleteCollectionRow(
    value: EditableCollectionValue,
    rowIndex: number,
): EditableCollectionValue {
    switch (value.kind) {
        case "hash":
            return {
                kind: "hash",
                value: value.value.filter((_, currentIndex) => currentIndex !== rowIndex),
            };
        case "list":
            return {
                kind: "list",
                value: value.value.filter((_, currentIndex) => currentIndex !== rowIndex),
            };
        case "set":
            return {
                kind: "set",
                value: value.value.filter((_, currentIndex) => currentIndex !== rowIndex),
            };
        case "sorted_set":
            return {
                kind: "sorted_set",
                value: value.value.filter((_, currentIndex) => currentIndex !== rowIndex),
            };
        case "stream": {
            const target = resolveStreamFieldIndex(value, rowIndex);
            if (!target) return value;

            return {
                kind: "stream",
                value: value.value.flatMap((entry, entryIndex) => {
                    if (entryIndex !== target.entryIndex) return [entry];
                    if (entry.fields.length <= 1) return [];

                    return [
                        {
                            ...entry,
                            fields: entry.fields.filter(
                                (_field, fieldIndex) => fieldIndex !== target.fieldIndex,
                            ),
                        },
                    ];
                }),
            };
        }
    }
}

export const CREATE_KEY_TYPE_OPTIONS = [
    { value: "string", label: "String" },
    { value: "json", label: "JSON" },
    { value: "hash", label: "Hash" },
    { value: "list", label: "List" },
    { value: "set", label: "Set" },
    { value: "sorted_set", label: "ZSet" },
    { value: "stream", label: "Stream" },
] as const satisfies ReadonlyArray<{
    value: KeyValueEditableDraftValue["kind"];
    label: string;
}>;
