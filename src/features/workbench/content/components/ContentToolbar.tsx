import { ChevronDown } from "lucide-react";

import { BaseButton, Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
    useContentToolbarStore,
    useWorkbenchTabsStore as useTabsStore,
} from "@/store";

export function ContentToolbar() {
    const activeTabId = useTabsStore((state) => state.activeTabId);
    const hasActiveTab = useTabsStore((state) =>
        state.activeTabId
            ? state.tabs.some((tab) => tab.id === state.activeTabId)
            : false,
    );
    const toolbarModel = useContentToolbarStore((state) =>
        activeTabId ? state.modelsByTabId[activeTabId] : undefined,
    );

    const actions = toolbarModel?.actions ?? [];
    const context = actions.length > 0 ? toolbarModel?.context : null;
    const ContextIcon = context?.icon ?? null;
    const emptyText =
        toolbarModel?.emptyText ??
        (hasActiveTab ? "当前标签页没有可用操作" : "打开一个标签页以显示操作");

    return (
        <div className="flex flex-col border-b">
            <div className="flex h-10 items-center gap-1 px-2">
                {actions.length === 0 ? (
                    <span className="px-2 text-xs text-muted-foreground">
                        {emptyText}
                    </span>
                ) : (
                    actions.map((action) => {
                        const Icon = action.icon;
                        const isPrimary = action.variant === "default";
                        const menuItems = action.menuItems ?? [];
                        if (isPrimary && menuItems.length > 0) {
                            return (
                                <div key={action.id} className="flex items-center">
                                    <Button
                                        size="sm"
                                        variant="default"
                                        title={action.title}
                                        aria-pressed={action.pressed}
                                        data-state={action.pressed ? "on" : "off"}
                                        className="h-7 gap-1.5 rounded-r-none px-3 text-xs data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
                                        disabled={action.disabled}
                                        onClick={action.onClick}
                                    >
                                        <Icon data-icon="inline-start" />
                                        {action.label}
                                    </Button>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger
                                            render={<BaseButton
                                                size="icon"
                                                variant="default"
                                                title={`${action.label}选项`}
                                                aria-label={`${action.label}选项`}
                                                className="size-7 rounded-l-none border-l border-primary-foreground/20"
                                                disabled={action.disabled}
                                            >
                                                <ChevronDown className="size-3.5" />
                                            </BaseButton>}
                                        />
                                        <DropdownMenuContent
                                            align="start"
                                            className="w-44"
                                        >
                                            {menuItems.map((item) => {
                                                const ItemIcon = item.icon;
                                                return (
                                                    <DropdownMenuItem
                                                        key={item.id}
                                                        title={item.title}
                                                        disabled={item.disabled}
                                                        className="text-xs"
                                                        onClick={() => {
                                                            item.onClick?.();
                                                        }}
                                                    >
                                                        {ItemIcon && (
                                                            <ItemIcon className="size-3.5" />
                                                        )}
                                                        <span>{item.label}</span>
                                                    </DropdownMenuItem>
                                                );
                                            })}
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                            );
                        }
                        if (!isPrimary && menuItems.length > 0) {
                            return (
                                <DropdownMenu key={action.id}>
                                    <DropdownMenuTrigger
                                        render={<BaseButton
                                            size="icon"
                                            variant="ghost"
                                            title={action.title}
                                            aria-label={action.label}
                                            aria-pressed={action.pressed}
                                            data-state={
                                                action.pressed ? "on" : "off"
                                            }
                                            className="size-7 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
                                            disabled={action.disabled}
                                        >
                                            <Icon />
                                        </BaseButton>}
                                    />
                                    <DropdownMenuContent
                                        align="start"
                                        className="w-44"
                                    >
                                        {menuItems.map((item) => {
                                            const ItemIcon = item.icon;
                                            return (
                                                <DropdownMenuItem
                                                    key={item.id}
                                                    title={item.title}
                                                    disabled={item.disabled}
                                                    className="text-xs"
                                                    onClick={() =>
                                                        item.onClick?.()
                                                    }
                                                >
                                                    {ItemIcon ? (
                                                        <ItemIcon className="size-3.5" />
                                                    ) : null}
                                                    <span>{item.label}</span>
                                                </DropdownMenuItem>
                                            );
                                        })}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            );
                        }
                        return isPrimary ? (
                            <Button
                                key={action.id}
                                size="sm"
                                variant="default"
                                title={action.title}
                                aria-pressed={action.pressed}
                                data-state={action.pressed ? "on" : "off"}
                                className="h-7 gap-1.5 px-3 text-xs data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
                                disabled={action.disabled}
                                onClick={action.onClick}
                            >
                                <Icon data-icon="inline-start" />
                                {action.label}
                            </Button>
                        ) : (
                            <Button
                                key={action.id}
                                size="icon"
                                variant="ghost"
                                title={action.title}
                                aria-label={action.label}
                                aria-pressed={action.pressed}
                                data-state={action.pressed ? "on" : "off"}
                                className="size-7 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
                                disabled={action.disabled}
                                onClick={action.onClick}
                            >
                                <Icon />
                            </Button>
                        );
                    })
                )}

                {context && ContextIcon && (
                    <>
                        <Separator orientation="vertical" className="mx-1 my-2" />
                        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                            <ContextIcon className="size-3.5" />
                            <span className="truncate">{context.label}</span>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
