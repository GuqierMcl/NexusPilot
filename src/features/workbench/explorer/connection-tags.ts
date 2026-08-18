import type { ConnectionTagColor, StoredDatabaseConnection } from "@/types";

export const CONNECTION_TAG_LABEL_MAX_LENGTH = 8;
export const DEFAULT_CONNECTION_TAG_COLOR: ConnectionTagColor = "sky";

export type ConnectionTagColorSpec = {
    value: ConnectionTagColor;
    label: string;
    swatchClassName: string;
    markerClassName: string;
    badgeClassName: string;
};

export const CONNECTION_TAG_COLORS = [
    {
        value: "slate",
        label: "灰色",
        swatchClassName: "bg-slate-500",
        markerClassName: "bg-slate-500",
        badgeClassName:
            "bg-slate-500/10 text-slate-700 ring-slate-500/25 dark:text-slate-300",
    },
    {
        value: "red",
        label: "红色",
        swatchClassName: "bg-red-500",
        markerClassName: "bg-red-500",
        badgeClassName:
            "bg-red-500/10 text-red-700 ring-red-500/25 dark:text-red-300",
    },
    {
        value: "orange",
        label: "橙色",
        swatchClassName: "bg-orange-500",
        markerClassName: "bg-orange-500",
        badgeClassName:
            "bg-orange-500/10 text-orange-700 ring-orange-500/25 dark:text-orange-300",
    },
    {
        value: "amber",
        label: "琥珀",
        swatchClassName: "bg-amber-500",
        markerClassName: "bg-amber-500",
        badgeClassName:
            "bg-amber-500/10 text-amber-800 ring-amber-500/25 dark:text-amber-300",
    },
    {
        value: "emerald",
        label: "绿色",
        swatchClassName: "bg-emerald-500",
        markerClassName: "bg-emerald-500",
        badgeClassName:
            "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
    },
    {
        value: "teal",
        label: "青色",
        swatchClassName: "bg-teal-500",
        markerClassName: "bg-teal-500",
        badgeClassName:
            "bg-teal-500/10 text-teal-700 ring-teal-500/25 dark:text-teal-300",
    },
    {
        value: "sky",
        label: "蓝色",
        swatchClassName: "bg-sky-500",
        markerClassName: "bg-sky-500",
        badgeClassName:
            "bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300",
    },
    {
        value: "violet",
        label: "紫色",
        swatchClassName: "bg-violet-500",
        markerClassName: "bg-violet-500",
        badgeClassName:
            "bg-violet-500/10 text-violet-700 ring-violet-500/25 dark:text-violet-300",
    },
    {
        value: "pink",
        label: "粉色",
        swatchClassName: "bg-pink-500",
        markerClassName: "bg-pink-500",
        badgeClassName:
            "bg-pink-500/10 text-pink-700 ring-pink-500/25 dark:text-pink-300",
    },
] as const satisfies readonly ConnectionTagColorSpec[];

const CONNECTION_TAG_COLOR_MAP = new Map<ConnectionTagColor, ConnectionTagColorSpec>(
    CONNECTION_TAG_COLORS.map((color) => [color.value, color]),
);

export type ConnectionTagInput = {
    tagLabel?: string | null;
    tagColor?: string | null;
};

export type NormalizedConnectionTag = {
    tagLabel: string;
    tagColor: ConnectionTagColor | null;
};

export type ConnectionTagRenderModel =
    | { kind: "none" }
    | { kind: "marker"; color: ConnectionTagColorSpec }
    | { kind: "pill"; label: string; color: ConnectionTagColorSpec };

export function getConnectionTagColor(
    value: string | null | undefined,
): ConnectionTagColorSpec | null {
    if (!value) {
        return null;
    }

    return CONNECTION_TAG_COLOR_MAP.get(value as ConnectionTagColor) ?? null;
}

export function normalizeConnectionTagLabel(value: string | null | undefined): string {
    return Array.from((value ?? "").trim())
        .slice(0, CONNECTION_TAG_LABEL_MAX_LENGTH)
        .join("");
}

export function normalizeConnectionTagInput(
    input: ConnectionTagInput,
): NormalizedConnectionTag {
    const tagLabel = normalizeConnectionTagLabel(input.tagLabel);
    const color = getConnectionTagColor(input.tagColor);

    if (!tagLabel && !color) {
        return { tagLabel: "", tagColor: null };
    }

    if (tagLabel && !color) {
        return { tagLabel, tagColor: DEFAULT_CONNECTION_TAG_COLOR };
    }

    return {
        tagLabel,
        tagColor: color?.value ?? null,
    };
}

export function getConnectionTagRenderModel(
    input: ConnectionTagInput,
): ConnectionTagRenderModel {
    const normalized = normalizeConnectionTagInput(input);
    const color = getConnectionTagColor(normalized.tagColor);

    if (!color) {
        return { kind: "none" };
    }

    if (!normalized.tagLabel) {
        return { kind: "marker", color };
    }

    return { kind: "pill", label: normalized.tagLabel, color };
}

export function getConnectionTagInput(
    connection: StoredDatabaseConnection,
): NormalizedConnectionTag {
    return normalizeConnectionTagInput({
        tagLabel: connection.tagLabel,
        tagColor: connection.tagColor,
    });
}
