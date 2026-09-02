const SAFE_INLINE_IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
]);

export function isSafeInlineImageType(mediaType: string | undefined): boolean {
    if (!mediaType) return false;
    const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase();
    return Boolean(normalized && SAFE_INLINE_IMAGE_TYPES.has(normalized));
}
