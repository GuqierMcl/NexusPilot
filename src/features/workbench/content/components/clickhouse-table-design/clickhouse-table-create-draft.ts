import type {
    ClickHouseCodecDraft,
    ClickHouseColumnCreateDraft,
    ClickHouseTableCreateDraft,
} from "@/types/clickhouse-table-design";
import type {
    ClickHouseCodecTarget,
    ClickHouseCreateTableTarget,
    ClickHouseTableSchema,
} from "@/types/ipc";

const SUPPORTED_CODECS = new Set([
    "LZ4",
    "ZSTD",
    "Delta",
    "DoubleDelta",
    "Gorilla",
    "T64",
    "FPC",
]);

function createDraftId(prefix: string): string {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) return `${prefix}-${randomUuid}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createBlankColumn(): ClickHouseColumnCreateDraft {
    return {
        id: createDraftId("column"),
        name: "",
        typeName: "",
        defaultKind: "none",
        defaultExpression: "",
        codecs: [],
        ttlExpression: "",
        comment: "",
    };
}

function optionalText(value: string): string | null {
    return value.trim().length === 0 ? null : value;
}

export function createClickHouseTableDraft(
    database: string,
): ClickHouseTableCreateDraft {
    return {
        database,
        name: "",
        columns: [createBlankColumn()],
        engineFamily: "MergeTree",
        engineArguments: [],
        orderBy: "tuple()",
        partitionBy: "",
        primaryKey: "",
        sampleBy: "",
        tableTtl: "",
        settings: [],
        comment: "",
    };
}

export function cloneClickHouseTableCreateDraft(
    draft: ClickHouseTableCreateDraft,
): ClickHouseTableCreateDraft {
    return {
        ...draft,
        columns: draft.columns.map((column) => ({
            ...column,
            codecs: column.codecs.map((codec) => ({
                ...codec,
                arguments: [...codec.arguments],
            })),
        })),
        engineArguments: [...draft.engineArguments],
        settings: draft.settings.map((setting) => ({ ...setting })),
    };
}

export function clickHouseDraftToCreateTarget(
    draft: ClickHouseTableCreateDraft,
): ClickHouseCreateTableTarget {
    return {
        database: draft.database,
        name: draft.name,
        columns: draft.columns.map((column) => ({
            name: column.name,
            typeName: column.typeName,
            defaultKind: column.defaultKind,
            defaultExpression:
                column.defaultKind === "none"
                    ? null
                    : optionalText(column.defaultExpression),
            codecs: column.codecs.map((codec) => ({
                name: codec.name,
                arguments: [...codec.arguments],
            })),
            ttlExpression: optionalText(column.ttlExpression),
            comment: optionalText(column.comment),
        })),
        engine: {
            family: draft.engineFamily,
            arguments: [...draft.engineArguments],
        },
        keys: {
            orderBy: draft.orderBy,
            partitionBy: optionalText(draft.partitionBy),
            primaryKey: optionalText(draft.primaryKey),
            sampleBy: optionalText(draft.sampleBy),
        },
        tableTtl: optionalText(draft.tableTtl),
        comment: optionalText(draft.comment),
        settings: draft.settings.map((setting) => ({
            name: setting.name,
            value: setting.value,
        })),
    };
}

function matchingDelimiter(opening: string): string {
    switch (opening) {
        case "(":
            return ")";
        case "[":
            return "]";
        case "{":
            return "}";
        default:
            throw new Error("Unsupported ClickHouse codec delimiter");
    }
}

function splitTopLevel(input: string): string[] {
    const parts: string[] = [];
    const delimiters: string[] = [];
    let quote: "'" | '"' | "`" | null = null;
    let escaped = false;
    let partStart = 0;

    for (let index = 0; index < input.length; index += 1) {
        const character = input[index];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (character === "\\") {
                escaped = true;
                continue;
            }
            if (character === quote) {
                if (input[index + 1] === quote) {
                    index += 1;
                } else {
                    quote = null;
                }
            }
            continue;
        }

        if (character === "'" || character === '"' || character === "`") {
            quote = character;
            continue;
        }
        if (character === "(" || character === "[" || character === "{") {
            delimiters.push(matchingDelimiter(character));
            continue;
        }
        if (character === ")" || character === "]" || character === "}") {
            if (delimiters.pop() !== character) {
                throw new Error("Unsupported ClickHouse codec expression");
            }
            continue;
        }
        if (character === "," && delimiters.length === 0) {
            parts.push(input.slice(partStart, index).trim());
            partStart = index + 1;
        }
    }

    if (quote || delimiters.length > 0) {
        throw new Error("Unsupported ClickHouse codec expression");
    }
    parts.push(input.slice(partStart).trim());
    if (parts.some((part) => part.length === 0)) {
        throw new Error("Unsupported ClickHouse codec expression");
    }
    return parts;
}

function parseCodec(codecExpression: string): ClickHouseCodecTarget {
    const openingIndex = codecExpression.indexOf("(");
    let name = codecExpression;
    let argumentsList: string[] = [];

    if (openingIndex >= 0) {
        if (!codecExpression.endsWith(")")) {
            throw new Error("Unsupported ClickHouse codec expression");
        }
        name = codecExpression.slice(0, openingIndex).trim();
        const argumentsSource = codecExpression.slice(openingIndex + 1, -1);
        argumentsList = splitTopLevel(argumentsSource);
    }

    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || !SUPPORTED_CODECS.has(name)) {
        throw new Error(`Unsupported ClickHouse codec: ${name || "<empty>"}`);
    }
    return { name, arguments: argumentsList };
}

function parseCodecExpression(
    codecExpression: string | null,
): ClickHouseCodecTarget[] {
    if (codecExpression == null) return [];
    const trimmed = codecExpression.trim();
    if (!trimmed.startsWith("CODEC(") || !trimmed.endsWith(")")) {
        throw new Error("Unsupported ClickHouse codec expression");
    }
    const body = trimmed.slice("CODEC(".length, -1);
    return splitTopLevel(body).map(parseCodec);
}

function codecTargetToDraft(codec: ClickHouseCodecTarget): ClickHouseCodecDraft {
    return {
        id: createDraftId("codec"),
        name: codec.name,
        arguments: [...codec.arguments],
    };
}

export function clickHouseSchemaToCreateDraft(
    schema: ClickHouseTableSchema,
): ClickHouseTableCreateDraft {
    return {
        database: schema.identity.database,
        name: schema.identity.name,
        columns: schema.columns.map((column) => ({
            id: createDraftId("column"),
            name: column.name,
            typeName: column.typeName,
            defaultKind: column.defaultKind,
            defaultExpression: column.defaultExpression ?? "",
            codecs: parseCodecExpression(column.codecExpression).map(
                codecTargetToDraft,
            ),
            ttlExpression: column.ttlExpression ?? "",
            comment: column.comment ?? "",
        })),
        engineFamily: schema.engine.family,
        engineArguments: [...schema.engine.arguments],
        orderBy: schema.keys.orderBy,
        partitionBy: schema.keys.partitionBy ?? "",
        primaryKey: schema.keys.primaryKey ?? "",
        sampleBy: schema.keys.sampleBy ?? "",
        tableTtl: schema.tableTtl ?? "",
        settings: schema.settings
            .filter((setting) => setting.explicit)
            .map((setting) => ({
                id: createDraftId("setting"),
                name: setting.name,
                value: setting.value,
            })),
        comment: schema.comment ?? "",
    };
}
