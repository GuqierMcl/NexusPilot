export const CONNECTION_NOTE_MAX_LENGTH = 50;

/**
 * Shared with Rust's `is_connection_note_boundary_whitespace`.
 *
 * This is the Unicode White_Space property plus U+FEFF (BOM), which
 * ECMAScript historically treats as whitespace. Keeping the code-point list
 * explicit prevents `String.trim()` and Rust `str::trim()` from diverging.
 */
function isConnectionNoteBoundaryWhitespace(character: string): boolean {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (
        (codePoint >= 0x0009 && codePoint <= 0x000D)
        || codePoint === 0x0020
        || codePoint === 0x0085
        || codePoint === 0x00A0
        || codePoint === 0x1680
        || (codePoint >= 0x2000 && codePoint <= 0x200A)
        || codePoint === 0x2028
        || codePoint === 0x2029
        || codePoint === 0x202F
        || codePoint === 0x205F
        || codePoint === 0x3000
        || codePoint === 0xFEFF
    );
}

export function normalizeConnectionNote(value: string | null | undefined): string {
    const characters = Array.from(value ?? "");
    let start = 0;
    let end = characters.length;

    while (
        start < end
        && isConnectionNoteBoundaryWhitespace(characters[start] ?? "")
    ) {
        start += 1;
    }
    while (
        end > start
        && isConnectionNoteBoundaryWhitespace(characters[end - 1] ?? "")
    ) {
        end -= 1;
    }

    return characters.slice(start, end).join("");
}

export function countConnectionNoteCharacters(
    value: string | null | undefined,
): number {
    return Array.from(value ?? "").length;
}

export function isConnectionNoteWithinLimit(
    value: string | null | undefined,
): boolean {
    return countConnectionNoteCharacters(normalizeConnectionNote(value))
        <= CONNECTION_NOTE_MAX_LENGTH;
}
