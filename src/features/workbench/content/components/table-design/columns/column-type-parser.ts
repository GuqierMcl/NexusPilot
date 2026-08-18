import type { TableDesignDriverProfile } from "../driver-profiles";
import { createRawColumnTypeDraft, type ColumnTypeDraft } from "./column-type-model";

const TYPE_PATTERN = /^\s*([a-zA-Z][\w$]*)(?:\s*\((.*)\))?(?:\s+(unsigned))?\s*$/i;

function splitArgs(value: string): string[] {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

export function parseColumnType(
    typeName: string,
    profile: TableDesignDriverProfile,
): ColumnTypeDraft {
    const trimmed = typeName.trim();
    const match = TYPE_PATTERN.exec(trimmed);
    if (!match) return createRawColumnTypeDraft(trimmed);

    const [, rawBaseType, rawArgs = "", unsigned] = match;
    const definition = profile.typeCatalog.find(
        (item) => item.baseType.toLowerCase() === rawBaseType.toLowerCase(),
    );
    if (!definition) return createRawColumnTypeDraft(trimmed);

    const args = splitArgs(rawArgs);
    const firstArg = args[0] ?? "";
    const secondArg = args[1] ?? "";
    const charSemanticsMatch = /^(\d+)\s+(byte|char)$/i.exec(firstArg);

    return {
        mode: "structured",
        family: definition.family,
        baseType: definition.baseType,
        length: definition.supportsLength
            ? charSemanticsMatch?.[1] ?? firstArg
            : "",
        precision: definition.supportsPrecisionScale ? firstArg : "",
        scale: definition.supportsPrecisionScale ? secondArg : "",
        timePrecision: definition.supportsTimePrecision ? firstArg : "",
        unsigned: Boolean(unsigned),
        charSemantics: charSemanticsMatch
            ? (charSemanticsMatch[2].toLowerCase() as "byte" | "char")
            : "",
        enumValues: [],
        rawTypeName: "",
    };
}
