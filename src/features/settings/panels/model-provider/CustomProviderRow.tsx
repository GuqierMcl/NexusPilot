import { PlusIcon, SparklesIcon } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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

interface CustomProviderRowProps {
    isPending: boolean;
    onConnect: () => void;
}

export function CustomProviderRow({ isPending, onConnect }: CustomProviderRowProps) {
    return (
        <Item
            variant="default"
            className="border-border/60 bg-background hover:bg-muted/30"
        >
            <ItemMedia>
                <Avatar size="sm">
                    <AvatarFallback className="[&>svg]:size-3">
                        <SparklesIcon />
                    </AvatarFallback>
                </Avatar>
            </ItemMedia>
            <ItemContent className="min-w-0">
                <ItemTitle className="min-w-0 max-w-full">
                    <span className="truncate">自定义供应商</span>
                    <Badge variant="outline" className="shrink-0">
                        自定义
                    </Badge>
                </ItemTitle>
                <ItemDescription className="truncate">
                    通过基础 URL 添加与 OpenAI 兼容的提供商。
                </ItemDescription>
            </ItemContent>
            <ItemActions className="shrink-0">
                <Button
                    variant="outline"
                    disabled={isPending}
                    onClick={onConnect}
                >
                    <PlusIcon data-icon="inline-start" />
                    连接
                </Button>
            </ItemActions>
        </Item>
    );
}
