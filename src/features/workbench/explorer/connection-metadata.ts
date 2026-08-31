import type { ConnectionTagColor } from "@/types";

import { normalizeConnectionTagInput } from "@/features/workbench/explorer/connection-tags";
import { normalizeConnectionNote } from "@/features/workbench/explorer/connection-notes";

export interface ConnectionMetadataInput {
    tagLabel: string;
    tagColor: ConnectionTagColor | null;
    note: string;
}

export interface ConnectionMetadataSummary {
    text: string;
    tagColor: ConnectionTagColor | null;
}

export interface ConnectionMetadataDisclosureState {
    open: boolean;
    focusNote: boolean;
}

export type ConnectionMetadataDisclosureAction =
    | { type: "reset" }
    | { type: "set-open"; open: boolean }
    | { type: "reveal-invalid-note" }
    | { type: "note-focused" };

export function buildConnectionMetadataSummary(
    input: ConnectionMetadataInput,
): ConnectionMetadataSummary {
    const tag = normalizeConnectionTagInput(input);
    const noteSummary = normalizeConnectionNote(input.note)
        .replace(/(?:\r\n|[\n\r\u2028\u2029])+/gu, " ");
    let text = tag.tagLabel || (tag.tagColor ? "已设置颜色" : "");

    if (noteSummary) {
        text = text ? `${text} · ${noteSummary}` : noteSummary;
    }

    return {
        text: text || "未设置",
        tagColor: tag.tagColor,
    };
}

export function createConnectionMetadataDisclosureState(): ConnectionMetadataDisclosureState {
    return { open: false, focusNote: false };
}

export function reduceConnectionMetadataDisclosure(
    state: ConnectionMetadataDisclosureState,
    action: ConnectionMetadataDisclosureAction,
): ConnectionMetadataDisclosureState {
    switch (action.type) {
        case "reset":
            return createConnectionMetadataDisclosureState();
        case "set-open":
            return {
                open: action.open,
                focusNote: false,
            };
        case "reveal-invalid-note":
            return {
                open: true,
                focusNote: true,
            };
        case "note-focused":
            return {
                ...state,
                focusNote: false,
            };
    }
}
