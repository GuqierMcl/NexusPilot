import type { ComponentProps, ReactNode } from "react";

import {
    Avatar,
    AvatarFallback,
    AvatarImage,
} from "@/components/ui/avatar";

const MODELS_DEV_LOGO_BASE_URL = "https://models.dev/logos";

type AvatarSize = ComponentProps<typeof Avatar>["size"];

interface ProviderLogoAvatarProps {
    providerId: string;
    providerName: string;
    size?: AvatarSize;
    fallback?: ReactNode;
}

export function getModelsDevProviderLogoUrl(providerId: string): string {
    return `${MODELS_DEV_LOGO_BASE_URL}/${encodeURIComponent(providerId.trim())}.svg`;
}

function providerInitial(providerName: string): string {
    return providerName.trim().charAt(0).toUpperCase() || "AI";
}

export function ProviderLogoAvatar({
    providerId,
    providerName,
    size = "sm",
    fallback,
}: ProviderLogoAvatarProps) {
    return (
        <Avatar size={size}>
            <AvatarImage
                src={getModelsDevProviderLogoUrl(providerId)}
                alt={`${providerName} logo`}
                className="bg-background p-1 object-contain dark:bg-foreground"
            />
            <AvatarFallback>
                {fallback ?? providerInitial(providerName)}
            </AvatarFallback>
        </Avatar>
    );
}
