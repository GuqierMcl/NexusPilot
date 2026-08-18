const DEFAULT_INTERFACE_FONT_FAMILIES = ["Geist Variable", "sans-serif"] as const;

const GENERIC_FONT_FAMILIES = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "emoji",
    "math",
    "fangsong",
]);

const INVALID_FONT_FAMILY_CHARS = /[;{}\r\n]/;
const ROOT_INTERFACE_FONT_VARIABLE = "--app-font-sans";

function stripWrappingQuotes(value: string): string {
    if (value.length < 2) {
        return value;
    }

    const first = value[0];
    const last = value[value.length - 1];
    if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
        return value.slice(1, -1).trim();
    }

    return value;
}

function normalizeFontFamilyName(value: string): string | null {
    const normalized = stripWrappingQuotes(value.trim()).replace(/\s+/g, " ");
    if (!normalized || INVALID_FONT_FAMILY_CHARS.test(normalized)) {
        return null;
    }

    return normalized;
}

function quoteFontFamilyName(value: string): string {
    const lowerValue = value.toLowerCase();
    if (GENERIC_FONT_FAMILIES.has(lowerValue)) {
        return lowerValue;
    }

    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildInterfaceFontFamilyCss(input: string): string {
    const seen = new Set<string>();
    const fontFamilies = input
        .split(",")
        .map(normalizeFontFamilyName)
        .filter((value): value is string => value != null)
        .filter((value) => {
            const key = value.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });

    for (const fontFamily of DEFAULT_INTERFACE_FONT_FAMILIES) {
        const key = fontFamily.toLowerCase();
        if (!seen.has(key)) {
            fontFamilies.push(fontFamily);
            seen.add(key);
        }
    }

    return fontFamilies.map(quoteFontFamilyName).join(", ");
}

export function applyInterfaceFontFamily(input: string): void {
    if (typeof document === "undefined") {
        return;
    }

    document.documentElement.style.setProperty(
        ROOT_INTERFACE_FONT_VARIABLE,
        buildInterfaceFontFamilyCss(input),
    );
}
