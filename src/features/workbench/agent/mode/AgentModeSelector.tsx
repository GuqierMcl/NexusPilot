"use client";

import {
    AtomIcon,
    ChevronsUpDownIcon,
    CircleHelpIcon,
    MessageCircleQuestionMarkIcon,
    SearchCodeIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Command,
    CommandGroup,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import type { AvailableAgentMode } from "@/lib/ai-runtime/agent-modes";
import type { RunAgentMode } from "@/lib/ai-runtime/runs";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/store/slices/settings-slice";

import { useSelectedAiRuntimeAgentMode } from "./useSelectedAiRuntimeAgentMode";

const AGENT_MODE_THEME: Record<
    RunAgentMode,
    { trigger: string; selectedItem: string }
> = {
    ask: {
        trigger:
            "text-sky-600 hover:bg-sky-500/10 dark:text-sky-400 dark:hover:bg-sky-400/10",
        selectedItem:
            "data-[checked=true]:bg-sky-500/10 data-[checked=true]:text-sky-700 dark:data-[checked=true]:bg-sky-400/10 dark:data-[checked=true]:text-sky-300",
    },
    query: {
        trigger:
            "text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-400/10",
        selectedItem:
            "data-[checked=true]:bg-emerald-500/10 data-[checked=true]:text-emerald-700 dark:data-[checked=true]:bg-emerald-400/10 dark:data-[checked=true]:text-emerald-300",
    },
    agent: {
        trigger:
            "text-violet-600 hover:bg-violet-500/10 dark:text-violet-400 dark:hover:bg-violet-400/10",
        selectedItem:
            "data-[checked=true]:bg-violet-500/10 data-[checked=true]:text-violet-700 dark:data-[checked=true]:bg-violet-400/10 dark:data-[checked=true]:text-violet-300",
    },
};

function AgentModeIcon({
    agentMode,
    className,
}: {
    agentMode: RunAgentMode;
    className?: string;
}) {
    if (agentMode === "agent") {
        return <AtomIcon className={className} />;
    }
    if (agentMode === "query") {
        return <SearchCodeIcon className={className} />;
    }

    return <MessageCircleQuestionMarkIcon className={className} />;
}

function optionValue(option: AvailableAgentMode): string {
    return `${option.title} ${option.agentMode} ${option.description}`;
}

export function AgentModeSelector() {
    const [open, setOpen] = useState(false);
    const setSelectedAgentMode = useSettingsStore(
        (state) => state.setAiRuntimeSelectedAgentMode,
    );
    const {
        agentModeOptions,
        error,
        isLoading,
        isRuntimeCatalogKnown,
        selectedAgentMode,
        selectedAgentModeOption,
    } = useSelectedAiRuntimeAgentMode();
    const buttonLabel = selectedAgentModeOption?.title ?? "Ask";
    const selectedTheme = AGENT_MODE_THEME[selectedAgentMode];

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
                render={<Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                        "h-7 min-w-0 max-w-[120px] gap-1.5 rounded-full px-2 text-xs",
                        selectedTheme.trigger,
                    )}
                    aria-label="选择智能体模式"
                >
                    {selectedAgentModeOption ? (
                        <AgentModeIcon
                            agentMode={selectedAgentModeOption.agentMode}
                            className="size-3.5 shrink-0"
                        />
                    ) : (
                        <CircleHelpIcon className="size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 truncate">{buttonLabel}</span>
                    <ChevronsUpDownIcon className="size-3 shrink-0 opacity-60" />
                </Button>}
            />
            <PopoverContent
                align="start"
                side="top"
                className="w-[300px] p-0"
            >
                <Command>
                    <CommandList>
                        <CommandGroup heading="智能体模式">
                            {isLoading ? (
                                <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-sm">
                                    <Spinner className="size-4" />
                                    正在读取 AI Runtime 智能体模式
                                </div>
                            ) : null}
                            {!isRuntimeCatalogKnown && error ? (
                                <div className="text-muted-foreground px-2 py-2 text-xs">
                                    使用内置模式兜底
                                </div>
                            ) : null}
                            {agentModeOptions.map((option) => {
                                const selected =
                                    selectedAgentMode === option.agentMode;
                                const theme = AGENT_MODE_THEME[option.agentMode];

                                return (
                                    <CommandItem
                                        key={option.agentMode}
                                        data-checked={selected}
                                        value={optionValue(option)}
                                        className={theme.selectedItem}
                                        onSelect={() => {
                                            setSelectedAgentMode(option.agentMode);
                                            setOpen(false);
                                        }}
                                    >
                                        <AgentModeIcon
                                            agentMode={option.agentMode}
                                            className="size-4 shrink-0"
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm">
                                                {option.title}
                                            </div>
                                            <div className="text-muted-foreground truncate text-xs">
                                                {option.description}
                                            </div>
                                        </div>
                                    </CommandItem>
                                );
                            })}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
