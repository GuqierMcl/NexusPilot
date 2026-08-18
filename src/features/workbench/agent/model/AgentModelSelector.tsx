"use client";

import { ChevronsUpDownIcon, CpuIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { ProviderLogoAvatar } from "@/components/provider/provider-logo-avatar";
import type { AvailableRuntimeModel } from "@/lib/ai-runtime/providers";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/store/slices/settings-slice";

import { useSelectedAiRuntimeModel } from "./useSelectedAiRuntimeModel";

function modelKey(model: AvailableRuntimeModel): string {
    return `${model.providerId}:${model.modelId}`;
}

function formatModelLabel(model: AvailableRuntimeModel): string {
    return model.modelName;
}

function ProviderLogo({
    providerId,
    providerName,
    className,
}: {
    providerId: string;
    providerName: string;
    className?: string;
}) {
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center justify-center",
                className,
            )}
        >
            <ProviderLogoAvatar
                providerId={providerId}
                providerName={providerName}
                size="sm"
            />
        </span>
    );
}

function formatButtonLabel(input: {
    selectedModel: AvailableRuntimeModel | null;
    selectedModelPreference: { providerId: string; modelId: string } | null;
    hasStaleSelection: boolean;
    isAvailabilityKnown: boolean;
    isLoading: boolean;
}): string {
    if (input.selectedModel) {
        return formatModelLabel(input.selectedModel);
    }

    if (input.selectedModelPreference && input.isLoading) {
        return "正在加载模型";
    }

    if (input.hasStaleSelection) {
        return "模型不可用";
    }

    if (input.selectedModelPreference && !input.isAvailabilityKnown) {
        return "模型状态未知";
    }

    return "未选择模型";
}

interface AgentModelSelectorProps {
    onModelSettingsRequested?: () => void;
}

export function AgentModelSelector({
    onModelSettingsRequested,
}: AgentModelSelectorProps) {
    const [open, setOpen] = useState(false);
    const setSelectedModel = useSettingsStore(
        (state) => state.setAiRuntimeSelectedModel,
    );
    const {
        availableModels,
        hasStaleSelection,
        isAvailabilityKnown,
        isLoading,
        selectedModelPreference,
        selectedModel,
    } = useSelectedAiRuntimeModel();
    const buttonLabel = formatButtonLabel({
        selectedModel,
        selectedModelPreference,
        hasStaleSelection,
        isAvailabilityKnown,
        isLoading,
    });
    const buttonProviderLogo = selectedModel
        ? {
              providerId: selectedModel.providerId,
              providerName: selectedModel.providerName,
          }
        : selectedModelPreference
          ? {
                providerId: selectedModelPreference.providerId,
                providerName: selectedModelPreference.providerId,
            }
          : null;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
                render={<Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                        "h-7 min-w-0 max-w-[250px] gap-1.5 rounded-full px-2 text-xs",
                        !selectedModel && "text-muted-foreground",
                    )}
                    aria-label="选择 AI Runtime 模型"
                >
                    {buttonProviderLogo ? (
                        <ProviderLogo
                            providerId={buttonProviderLogo.providerId}
                            providerName={buttonProviderLogo.providerName}
                            className="-mx-0.5 scale-75"
                        />
                    ) : (
                        <CpuIcon className="size-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 truncate">{buttonLabel}</span>
                    <ChevronsUpDownIcon className="size-3 shrink-0 opacity-60" />
                </Button>}
            />
            <PopoverContent
                align="start"
                side="top"
                className="w-[320px] p-0"
            >
                <Command>
                    <CommandInput placeholder="搜索模型" />
                    <div className="flex shrink-0 items-center px-2 pt-1">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-foreground h-7 gap-1.5 px-1.5 text-xs font-normal"
                            aria-label="打开模型设置"
                            title="打开模型设置"
                            disabled={!onModelSettingsRequested}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                    event.stopPropagation();
                                }
                            }}
                            onClick={() => {
                                setOpen(false);
                                onModelSettingsRequested?.();
                            }}
                        >
                            <Settings2Icon className="size-3.5" />
                            管理模型
                        </Button>
                    </div>
                    <CommandList>
                        <CommandEmpty>
                            {isLoading
                                ? "正在加载模型"
                                : "没有可用模型"}
                        </CommandEmpty>
                        <CommandGroup>
                            {isLoading ? (
                                <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-sm">
                                    <Spinner className="size-4" />
                                    正在读取 AI Runtime 可用模型
                                </div>
                            ) : null}
                            {availableModels.map((model) => {
                                const selected =
                                    selectedModel?.providerId === model.providerId &&
                                    selectedModel?.modelId === model.modelId;

                                return (
                                    <CommandItem
                                        key={modelKey(model)}
                                        data-checked={selected}
                                        value={`${model.providerName} ${model.modelName} ${model.providerId} ${model.modelId}`}
                                        onSelect={() => {
                                            setSelectedModel({
                                                providerId: model.providerId,
                                                modelId: model.modelId,
                                            });
                                            setOpen(false);
                                        }}
                                    >
                                        <ProviderLogo
                                            providerId={model.providerId}
                                            providerName={model.providerName}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm">
                                                {model.modelName}
                                            </div>
                                            <div className="text-muted-foreground truncate text-xs">
                                                {model.providerName} · {model.modelId}
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
