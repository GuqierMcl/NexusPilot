export function isRuntimeConversationId(
    value: string | null | undefined,
): value is `conv_${string}` {
    return isRuntimeId(value, "conv");
}

export function isRuntimeId<TPrefix extends string>(
    value: string | null | undefined,
    prefix: TPrefix,
): value is `${TPrefix}_${string}` {
    if (typeof value !== "string") {
        return false;
    }

    const normalized = value.trim();
    return normalized.startsWith(`${prefix}_`) && normalized.length > prefix.length + 1;
}
