import type { TableDesignDriverProfile } from "../driver-profiles";
import type { ColumnTypeDraft } from "./column-type-model";

function maybeParen(value: string): string {
    const trimmed = value.trim();
    return trimmed ? `(${trimmed})` : "";
}

function precisionScale(precision: string, scale: string): string {
    const p = precision.trim();
    const s = scale.trim();
    if (!p) return "";
    return s ? `(${p},${s})` : `(${p})`;
}

function quoteEnumValue(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

export function formatColumnType(
    draft: ColumnTypeDraft,
    profile: TableDesignDriverProfile,
): string {
    if (draft.mode === "raw") return draft.rawTypeName.trim();

    const baseType = draft.baseType.trim();
    const normalized = baseType.toLowerCase();

    if (draft.enumValues.length > 0 && normalized === "enum") {
        return `enum(${draft.enumValues.map(quoteEnumValue).join(",")})`;
    }

    const unsigned =
        draft.unsigned && profile.columnOptions.unsigned ? " unsigned" : "";

    if (draft.precision.trim()) {
        return `${baseType}${precisionScale(draft.precision, draft.scale)}${unsigned}`;
    }

    if (draft.length.trim()) {
        const semantics =
            profile.columnOptions.charSemantics && draft.charSemantics
                ? ` ${draft.charSemantics.toUpperCase()}`
                : "";
        return `${baseType}(${draft.length.trim()}${semantics})`;
    }

    if (draft.timePrecision.trim()) {
        return `${baseType}${maybeParen(draft.timePrecision)}`;
    }

    return `${baseType}${unsigned}`;
}
