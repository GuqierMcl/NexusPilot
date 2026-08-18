import {
    KeyRoundIcon,
    LoaderCircleIcon,
    PlusIcon,
    TestTube2Icon,
    Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { TooltipIconButton } from "@/components/tooltip-icon-button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Field,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import {
    InputGroup,
    InputGroupInput,
} from "@/components/ui/input-group";
import { InputPassword } from "@/components/ui/input-password";
import { ScrollArea } from "@/components/ui/scroll-area";

import type { CustomModelDraft } from "./model-provider-utils";
import type { CustomProviderDialogMode } from "./useModelProviderPanelState";

interface CustomProviderDialogProps {
    mode: CustomProviderDialogMode;
    providerId: string;
    providerName: string;
    apiBase: string;
    apiKey: string;
    modelRows: CustomModelDraft[];
    canSubmit: boolean;
    canDiscoverModels: boolean;
    isPending: boolean;
    isDiscoveringModels: boolean;
    testingModelId: string | null;
    onOpenChange: (open: boolean) => void;
    onProviderIdChange: (value: string) => void;
    onProviderNameChange: (value: string) => void;
    onApiBaseChange: (value: string) => void;
    onApiKeyChange: (value: string) => void;
    onUpdateModelRow: (
        key: string,
        field: "id" | "name",
        value: string,
    ) => void;
    onRemoveModelRow: (key: string) => void;
    onAddModelRow: () => void;
    onDiscoverModels: () => void;
    onTestModel: (modelId: string) => void;
    onCancel: () => void;
    onSubmit: () => void;
}

export function CustomProviderDialog({
    mode,
    providerId,
    providerName,
    apiBase,
    apiKey,
    modelRows,
    canSubmit,
    canDiscoverModels,
    isPending,
    isDiscoveringModels,
    testingModelId,
    onOpenChange,
    onProviderIdChange,
    onProviderNameChange,
    onApiBaseChange,
    onApiKeyChange,
    onUpdateModelRow,
    onRemoveModelRow,
    onAddModelRow,
    onDiscoverModels,
    onTestModel,
    onCancel,
    onSubmit,
}: CustomProviderDialogProps) {
    return (
        <Dialog
            open={mode !== null}
            onOpenChange={onOpenChange}
        >
            <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-hidden">
                <DialogHeader className="shrink-0">
                    <DialogTitle>
                        {mode === "edit"
                            ? "编辑自定义供应商"
                            : "连接自定义供应商"}
                    </DialogTitle>
                    <DialogDescription>
                        添加与 OpenAI API 兼容的供应商。
                    </DialogDescription>
                </DialogHeader>

                <ScrollArea
                    className="max-h-[calc(100dvh-12rem)]"
                    contentWidth="viewport"
                >
                    <FieldGroup className="pr-3">
                    <Field>
                        <FieldLabel htmlFor="custom-provider-name">
                            供应商名称
                        </FieldLabel>
                        <InputGroup>
                            <InputGroupInput
                                id="custom-provider-name"
                                value={providerName}
                                placeholder="例如 My Gateway"
                                onChange={(event) =>
                                    onProviderNameChange(event.target.value)
                                }
                            />
                        </InputGroup>
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="custom-provider-id">
                            Provider ID
                        </FieldLabel>
                        <InputGroup>
                            <InputGroupInput
                                id="custom-provider-id"
                                value={providerId}
                                disabled={mode === "edit"}
                                placeholder="例如 my-gateway"
                                onChange={(event) =>
                                    onProviderIdChange(event.target.value)
                                }
                            />
                        </InputGroup>
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="custom-provider-api-base">
                            API Base
                        </FieldLabel>
                        <InputGroup>
                            <InputGroupInput
                                id="custom-provider-api-base"
                                value={apiBase}
                                placeholder="https://api.example.com/v1"
                                onChange={(event) =>
                                    onApiBaseChange(event.target.value)
                                }
                            />
                        </InputGroup>
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="custom-provider-api-key">
                            API 密钥
                        </FieldLabel>
                        <InputPassword
                            id="custom-provider-api-key"
                            value={apiKey}
                            leadingIcon={<KeyRoundIcon />}
                            placeholder="输入 API 密钥"
                            onChange={(event) =>
                                onApiKeyChange(event.target.value)
                            }
                        />
                    </Field>

                    <Field>
                        <div className="flex items-center justify-between gap-3">
                            <FieldLabel>模型</FieldLabel>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={!canDiscoverModels || isPending}
                                onClick={onDiscoverModels}
                            >
                                {isDiscoveringModels && (
                                    <LoaderCircleIcon
                                        className="animate-spin"
                                        data-icon="inline-start"
                                    />
                                )}
                                获取模型列表
                            </Button>
                        </div>
                        <div className="flex flex-col gap-2">
                            {modelRows.map((row, index) => (
                                <div
                                    key={row.key}
                                    className="flex items-center gap-2"
                                >
                                    <InputGroup>
                                        <InputGroupInput
                                            value={row.id}
                                            placeholder="model-id"
                                            aria-label={`模型 ${index + 1} ID`}
                                            onChange={(event) =>
                                                onUpdateModelRow(
                                                    row.key,
                                                    "id",
                                                    event.target.value,
                                                )
                                            }
                                        />
                                    </InputGroup>
                                    <InputGroup>
                                        <InputGroupInput
                                            value={row.name}
                                            placeholder="显示名称"
                                            aria-label={`模型 ${index + 1} 显示名称`}
                                            onChange={(event) =>
                                                onUpdateModelRow(
                                                    row.key,
                                                    "name",
                                                    event.target.value,
                                                )
                                            }
                                        />
                                    </InputGroup>
                                    <TooltipIconButton
                                        type="button"
                                        tooltip="测试工具调用"
                                        aria-label={`测试模型 ${index + 1} 的工具调用`}
                                        disabled={
                                            isPending ||
                                            !canDiscoverModels ||
                                            !row.id.trim()
                                        }
                                        onClick={() => onTestModel(row.id)}
                                    >
                                        {testingModelId === row.id ? (
                                            <LoaderCircleIcon className="animate-spin" />
                                        ) : (
                                            <TestTube2Icon />
                                        )}
                                    </TooltipIconButton>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`删除模型 ${index + 1}`}
                                        onClick={() =>
                                            onRemoveModelRow(row.key)
                                        }
                                    >
                                        <Trash2Icon />
                                    </Button>
                                </div>
                            ))}
                            <Button
                                type="button"
                                variant="ghost"
                                className="w-fit"
                                onClick={onAddModelRow}
                            >
                                <PlusIcon data-icon="inline-start" />
                                添加模型
                            </Button>
                        </div>
                    </Field>
                    </FieldGroup>
                </ScrollArea>

                <DialogFooter className="shrink-0">
                    <Button
                        variant="outline"
                        onClick={onCancel}
                    >
                        取消
                    </Button>
                    <Button
                        disabled={!canSubmit || isPending}
                        onClick={onSubmit}
                    >
                        {mode === "edit" ? "保存" : "连接"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
