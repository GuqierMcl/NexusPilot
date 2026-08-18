import { PencilIcon, PlusIcon } from "lucide-react";

import { ProviderLogoAvatar } from "@/components/provider/provider-logo-avatar";
import type { ProviderSummary } from "@/lib/ai-runtime/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Item,
    ItemActions,
    ItemContent,
    ItemDescription,
    ItemMedia,
    ItemTitle,
} from "@/components/ui/item";

import { PROTOCOL_LABELS, providerCredentialLabel } from "./model-provider-utils";

interface ProviderRowProps {
    provider: ProviderSummary;
    action: "connect" | "disconnect";
    isPending: boolean;
    onConnect: (provider: ProviderSummary) => void;
    onDisconnect: (provider: ProviderSummary) => void;
    onEdit: (provider: ProviderSummary) => void;
}

export function ProviderRow({
    provider,
    action,
    isPending,
    onConnect,
    onDisconnect,
    onEdit,
}: ProviderRowProps) {
    return (
        <Item
            variant="default"
            className="border-border/60 bg-background hover:bg-muted/30"
        >
            <ItemMedia>
                <ProviderLogoAvatar
                    providerId={provider.id}
                    providerName={provider.name}
                />
            </ItemMedia>
            <ItemContent className="min-w-0">
                <ItemTitle className="min-w-0 max-w-full">
                    <span className="truncate">{provider.name}</span>
                    <Badge variant="secondary" className="shrink-0">
                        {PROTOCOL_LABELS[provider.apiProtocol]}
                    </Badge>
                    <Badge variant="outline" className="shrink-0">
                        {providerCredentialLabel(provider)}
                    </Badge>
                </ItemTitle>
                {action === "connect" && (
                    <ItemDescription className="flex min-w-0 max-w-full items-center gap-1 text-xs">
                        <span className="shrink-0">
                            {provider.modelCount} 个模型
                        </span>
                        {provider.apiBase ? (
                            <>
                                <span className="shrink-0">·</span>
                                <span className="min-w-0 truncate">
                                    {provider.apiBase}
                                </span>
                            </>
                        ) : null}
                    </ItemDescription>
                )}
            </ItemContent>
            <ItemActions className="shrink-0">
                {action === "disconnect" ? (
                    <>
                        <Button
                            variant="ghost"
                            disabled={isPending}
                            onClick={() => onEdit(provider)}
                        >
                            <PencilIcon data-icon="inline-start" />
                            编辑
                        </Button>
                        <Button
                            variant="ghost"
                            disabled={isPending}
                            onClick={() => onDisconnect(provider)}
                        >
                            断开连接
                        </Button>
                    </>
                ) : (
                    <Button
                        variant="outline"
                        disabled={isPending}
                        onClick={() => onConnect(provider)}
                    >
                        <PlusIcon data-icon="inline-start" />
                        连接
                    </Button>
                )}
            </ItemActions>
        </Item>
    );
}
