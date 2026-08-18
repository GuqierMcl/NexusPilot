import { type ReactNode } from "react";

import { Minus, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
    FieldError,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverDescription,
    PopoverHeader,
    PopoverTitle,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
    RedisValuePreview,
} from "../redis-value-preview";
import {
    CREATE_KEY_TYPE_OPTIONS,
    displayTypeForEditableValue,
    formatCreateTtlLabel,
    getRedisTypeBadgeClass,
    isEditableCollectionValue,
    redisValueFromEditableValue,
} from "./redis-key-value-utils";
import { cn } from "@/lib/utils";
import type {
    KeyValueCreateDraft,
    KeyValueEditableDraftValue,
} from "@/store";

interface CreateKeyDialogProps {
    tabId: string;
    isActive: boolean;
    isCreateDialogOpen: boolean;
    createDraft: KeyValueCreateDraft | null;
    isCreateKeyDirty: boolean;
    createDraftValidationError: string | null;
    canSaveCreateKey: boolean;
    canAddCreateCollectionRow: boolean;
    canDeleteCreateCollectionRow: boolean;
    selectedCreateCollectionRowIndex: number | null;
    isCreateTtlPopoverOpen: boolean;
    isCreatePending: boolean;
    onOpenChange: (open: boolean) => void;
    onKeyDraftChange: (keyDraft: string) => void;
    onValueKindChange: (kind: string) => void;
    onTtlDraftChange: (ttlSecondsDraft: string) => void;
    onValueDraftChange: (nextValueDraft: KeyValueEditableDraftValue) => void;
    onAddCollectionRow: () => void;
    onDeleteCollectionRow: () => void;
    onSave: () => void;
    onCancel: () => void;
    onCreateTtlPopoverOpenChange: (open: boolean) => void;
    onSelectedCreateCollectionRowIndexChange: (index: number | null) => void;
}

export function CreateKeyDialog({
    tabId,
    isActive,
    isCreateDialogOpen,
    createDraft,
    isCreateKeyDirty,
    createDraftValidationError,
    canSaveCreateKey,
    canAddCreateCollectionRow,
    canDeleteCreateCollectionRow,
    selectedCreateCollectionRowIndex,
    isCreateTtlPopoverOpen,
    isCreatePending,
    onOpenChange,
    onKeyDraftChange,
    onValueKindChange,
    onTtlDraftChange,
    onValueDraftChange,
    onAddCollectionRow,
    onDeleteCollectionRow,
    onSave,
    onCancel,
    onCreateTtlPopoverOpenChange,
    onSelectedCreateCollectionRowIndexChange,
}: CreateKeyDialogProps): ReactNode {
    const createPreviewValue = createDraft
        ? redisValueFromEditableValue(createDraft.valueDraft)
        : undefined;
    const createCollectionValue = isEditableCollectionValue(createDraft?.valueDraft)
        ? createDraft.valueDraft
        : null;

    const createPreviewContent =
        createDraft && createPreviewValue ? (
            <RedisValuePreview
                value={createPreviewValue}
                stringPreviewMode="text"
                isActive={isActive && isCreateDialogOpen}
                editableValueDraft={createDraft.valueDraft}
                selectedCollectionRowIndex={selectedCreateCollectionRowIndex}
                validationError={
                    isCreateKeyDirty ? createDraftValidationError : null
                }
                onEditableValueDraftChange={onValueDraftChange}
                onSelectedCollectionRowIndexChange={
                    onSelectedCreateCollectionRowIndexChange
                }
            />
        ) : (
            <p className="text-sm text-muted-foreground">
                选择类型后编辑新 key 内容
            </p>
        );

    return (
        <Dialog
            open={isCreateDialogOpen}
            onOpenChange={onOpenChange}
        >
            <DialogContent className="flex h-[calc(100vh-4rem)] max-h-[760px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-4xl">
                <DialogHeader className="shrink-0">
                    <DialogTitle>新建 Redis key</DialogTitle>
                    <DialogDescription className="sr-only">
                        填写 key 名、类型、TTL 与 value 后创建 Redis key。
                    </DialogDescription>
                </DialogHeader>
                <FieldGroup className="grid shrink-0 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
                    <Field
                        data-invalid={
                            createDraft != null &&
                            createDraft.keyDraft.trim().length === 0 &&
                            isCreateKeyDirty
                        }
                    >
                        <FieldLabel htmlFor={`create-key-${tabId}`}>
                            键名
                        </FieldLabel>
                        <Input
                            id={`create-key-${tabId}`}
                            value={createDraft?.keyDraft ?? ""}
                            placeholder="key"
                            aria-invalid={
                                createDraft != null &&
                                createDraft.keyDraft.trim().length === 0 &&
                                isCreateKeyDirty
                            }
                            disabled={isCreatePending}
                            onChange={(event) =>
                                onKeyDraftChange(event.target.value)
                            }
                            className="font-mono text-xs"
                        />
                    </Field>
                    <Field>
                        <FieldLabel>类型</FieldLabel>
                        <Select
                            value={createDraft?.valueKind ?? "string"}
                            items={CREATE_KEY_TYPE_OPTIONS}
                            disabled={isCreatePending}
                            onValueChange={(kind) => {
                                if (kind != null) onValueKindChange(kind);
                            }}
                        >
                            <SelectTrigger size="sm" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    {CREATE_KEY_TYPE_OPTIONS.map((option) => (
                                        <SelectItem
                                            key={option.value}
                                            value={option.value}
                                        >
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field>
                        <FieldLabel>TTL</FieldLabel>
                        <Popover
                            open={isCreateTtlPopoverOpen}
                            onOpenChange={onCreateTtlPopoverOpenChange}
                        >
                            <PopoverTrigger
                                render={<Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    aria-label="编辑新 key TTL"
                                    disabled={
                                        !createDraft ||
                                        isCreatePending
                                    }
                                    className="h-8 shrink-0 px-2 font-mono text-xs"
                                >
                                    {formatCreateTtlLabel(createDraft)}
                                </Button>}
                            />
                            <PopoverContent align="end" className="w-72">
                                <PopoverHeader>
                                    <PopoverTitle>TTL</PopoverTitle>
                                    <PopoverDescription>
                                        {formatCreateTtlLabel(createDraft)}
                                    </PopoverDescription>
                                </PopoverHeader>
                                <FieldGroup className="gap-3">
                                    <Field
                                        data-invalid={
                                            createDraft?.ttlSecondsDraft.trim()
                                                .length
                                                ? createDraftValidationError ===
                                                  "TTL 必须是正整数秒数"
                                                : false
                                        }
                                    >
                                        <FieldLabel
                                            htmlFor={`create-ttl-${tabId}`}
                                        >
                                            过期时间（秒）
                                        </FieldLabel>
                                        <Input
                                            id={`create-ttl-${tabId}`}
                                            value={
                                                createDraft?.ttlSecondsDraft ??
                                                ""
                                            }
                                            inputMode="numeric"
                                            placeholder="例如 3600"
                                            aria-invalid={
                                                createDraftValidationError ===
                                                "TTL 必须是正整数秒数"
                                            }
                                            onChange={(event) =>
                                                onTtlDraftChange(
                                                    event.target.value,
                                                )
                                            }
                                        />
                                        {createDraftValidationError ===
                                        "TTL 必须是正整数秒数" ? (
                                            <FieldError>
                                                TTL 必须是正整数秒数
                                            </FieldError>
                                        ) : null}
                                    </Field>
                                </FieldGroup>
                                <div className="flex justify-end gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={() => {
                                            onTtlDraftChange("");
                                            onCreateTtlPopoverOpenChange(false);
                                        }}
                                    >
                                        不设置 TTL
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        onClick={() =>
                                            onCreateTtlPopoverOpenChange(false)
                                        }
                                    >
                                        完成
                                    </Button>
                                </div>
                            </PopoverContent>
                        </Popover>
                    </Field>
                </FieldGroup>
                <Separator className="shrink-0" />
                <div className="flex min-h-0 flex-1 flex-col gap-2">
                    <div className="flex min-h-7 items-center justify-between gap-2">
                        <Badge
                            variant="outline"
                            className={cn(
                                "shrink-0 uppercase",
                                getRedisTypeBadgeClass(
                                    createDraft
                                        ? displayTypeForEditableValue(
                                              createDraft.valueDraft,
                                          )
                                        : undefined,
                                ),
                            )}
                        >
                            {createDraft
                                ? displayTypeForEditableValue(
                                      createDraft.valueDraft,
                                  )
                                : "string"}
                        </Badge>
                        {createCollectionValue ? (
                            <div className="flex shrink-0 items-center gap-1">
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="outline"
                                    title="添加元素"
                                    aria-label="添加元素"
                                    disabled={!canAddCreateCollectionRow}
                                    onClick={onAddCollectionRow}
                                    className="size-7"
                                >
                                    <Plus />
                                </Button>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="outline"
                                    title="删除选中元素"
                                    aria-label="删除选中元素"
                                    disabled={!canDeleteCreateCollectionRow}
                                    onClick={onDeleteCollectionRow}
                                    className="size-7"
                                >
                                    <Minus />
                                </Button>
                            </div>
                        ) : null}
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col">
                        {createPreviewContent}
                    </div>
                </div>
                <DialogFooter className="shrink-0">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={isCreatePending}
                        onClick={onCancel}
                    >
                        取消
                    </Button>
                    <Button
                        type="button"
                        disabled={!canSaveCreateKey}
                        onClick={() => void onSave()}
                    >
                        {isCreatePending ? (
                            <Spinner data-icon="inline-start" />
                        ) : null}
                        创建
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
