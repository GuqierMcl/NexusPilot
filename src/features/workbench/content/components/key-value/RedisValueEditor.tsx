import {
    Minus,
    Plus,
    RefreshCw,
    Save,
    Trash2,
    Undo2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Field,
    FieldDescription,
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
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatIpcError } from "@/lib/ipc-error";
import { cn } from "@/lib/utils";
import type {
    KeyValueEditableDraftValue,
    KeyValueRuntimeState,
} from "@/store";
import type { RedisValue } from "@/types/ipc";

import {
    RedisValuePreview,
    STRING_PREVIEW_MODES,
    type StringPreviewMode,
} from "../redis-value-preview";
import {
    formatMemoryUsage,
    formatTtl,
    getRedisTypeBadgeClass,
} from "./redis-key-value-utils";

interface RedisValueEditorProps {
    tabId: string;
    isActive: boolean;
    resolvedKey: string | null;
    valueType?: string;
    value?: RedisValue;
    size?: number | null;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    isFetching: boolean;
    isEditableValue: boolean;
    valueDraft: KeyValueRuntimeState["valueDraft"];
    selectedCollectionRowIndex: number | null;
    validationError: string | null;
    effectiveStringPreviewMode: StringPreviewMode;
    showStringPreviewModes: boolean;
    isTtlPopoverOpen: boolean;
    ttlInput: string;
    displayTtl: number | null;
    isTtlPending: boolean;
    canSaveValue: boolean;
    isValueDraftDirty: boolean;
    isMutating: boolean;
    showCollectionActions: boolean;
    canAddCollectionRow: boolean;
    canDeleteCollectionRow: boolean;
    isDeletePending: boolean;
    onTtlPopoverOpenChange: (open: boolean) => void;
    onTtlInputChange: (value: string) => void;
    onSaveTtl: () => Promise<void>;
    onPersistTtl: () => Promise<void>;
    onSaveValueDraft: () => Promise<void>;
    onCancelValueDraft: () => void;
    onRefreshCurrentKey: () => void;
    onDeleteCurrentKey: () => void;
    onStringPreviewModeChange: (mode: string) => void;
    onAddCollectionRow: () => void;
    onDeleteCollectionRow: () => void;
    onValueDraftChange: (nextValueDraft: KeyValueEditableDraftValue) => void;
    onSelectedCollectionRowIndexChange: (rowIndex: number | null) => void;
    onKeyDraftChange: (keyDraft: string) => void;
}

export function RedisValueEditor({
    tabId,
    isActive,
    resolvedKey,
    valueType,
    value,
    size,
    isLoading,
    isError,
    error,
    isFetching,
    isEditableValue,
    valueDraft,
    selectedCollectionRowIndex,
    validationError,
    effectiveStringPreviewMode,
    showStringPreviewModes,
    isTtlPopoverOpen,
    ttlInput,
    displayTtl,
    isTtlPending,
    canSaveValue,
    isValueDraftDirty,
    isMutating,
    showCollectionActions,
    canAddCollectionRow,
    canDeleteCollectionRow,
    isDeletePending,
    onTtlPopoverOpenChange,
    onTtlInputChange,
    onSaveTtl,
    onPersistTtl,
    onSaveValueDraft,
    onCancelValueDraft,
    onRefreshCurrentKey,
    onDeleteCurrentKey,
    onStringPreviewModeChange,
    onAddCollectionRow,
    onDeleteCollectionRow,
    onValueDraftChange,
    onSelectedCollectionRowIndexChange,
    onKeyDraftChange,
}: RedisValueEditorProps) {
    const previewContent = isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            加载 value...
        </div>
    ) : isError ? (
        <p className="text-sm text-destructive">
            加载失败：{formatIpcError(error)}
        </p>
    ) : (
        <RedisValuePreview
            value={value}
            stringPreviewMode={effectiveStringPreviewMode}
            isActive={isActive}
            editableValueDraft={isEditableValue ? valueDraft?.valueDraft : undefined}
            selectedCollectionRowIndex={selectedCollectionRowIndex}
            validationError={validationError}
            onEditableValueDraftChange={
                isEditableValue ? onValueDraftChange : undefined
            }
            onSelectedCollectionRowIndexChange={
                onSelectedCollectionRowIndexChange
            }
        />
    );

    return (
        <section className="flex h-full min-w-0 flex-col">
            <div className="flex min-h-20 flex-col gap-2 border-b px-3 py-2 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                    <Badge
                        variant="outline"
                        className={cn(
                            "uppercase",
                            getRedisTypeBadgeClass(valueType),
                        )}
                    >
                        {valueType ?? "none"}
                    </Badge>
                    <Input
                        value={valueDraft?.keyDraft ?? resolvedKey ?? ""}
                        readOnly={!isEditableValue}
                        placeholder="未选择 key"
                        onChange={(event) =>
                            onKeyDraftChange(event.target.value)
                        }
                        className="h-7 min-w-0 flex-1 font-mono text-xs"
                    />
                    <Popover
                        open={isTtlPopoverOpen}
                        onOpenChange={onTtlPopoverOpenChange}
                    >
                        <PopoverTrigger
                            render={<Button
                                type="button"
                                size="sm"
                                variant="outline"
                                aria-label="编辑 TTL"
                                disabled={!value || isTtlPending}
                                className="h-7 shrink-0 px-2 font-mono text-xs"
                            >
                                TTL{" "}
                                {displayTtl == null ? "-" : formatTtl(displayTtl)}
                            </Button>}
                        />
                        <PopoverContent align="end" className="w-72">
                            <PopoverHeader>
                                <PopoverTitle>编辑 TTL</PopoverTitle>
                                <PopoverDescription>
                                    当前值：
                                    {displayTtl == null ? "-" : formatTtl(displayTtl)}
                                </PopoverDescription>
                            </PopoverHeader>
                            <FieldGroup className="gap-3">
                                <Field>
                                    <FieldLabel htmlFor={`ttl-${tabId}`}>
                                        过期时间（秒）
                                    </FieldLabel>
                                    <Input
                                        id={`ttl-${tabId}`}
                                        value={ttlInput}
                                        inputMode="numeric"
                                        placeholder="例如 3600"
                                        onChange={(event) =>
                                            onTtlInputChange(event.target.value)
                                        }
                                    />
                                    <FieldDescription>
                                        输入正整数后保存；移除过期时间会保留 key。
                                    </FieldDescription>
                                    {ttlInput.length > 0 &&
                                    (!Number.isInteger(Number(ttlInput)) ||
                                        Number(ttlInput) <= 0) ? (
                                        <FieldError>请输入正整数秒数</FieldError>
                                    ) : null}
                                </Field>
                            </FieldGroup>
                            <div className="flex justify-end gap-2">
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={isTtlPending}
                                    onClick={() => void onPersistTtl()}
                                >
                                    移除过期时间
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={isTtlPending}
                                    onClick={() => void onSaveTtl()}
                                >
                                    保存过期时间
                                </Button>
                            </div>
                        </PopoverContent>
                    </Popover>
                    {isEditableValue ? (
                        <>
                            <Button
                                type="button"
                                size="sm"
                                variant="default"
                                disabled={!canSaveValue}
                                onClick={() => void onSaveValueDraft()}
                                className="h-7 shrink-0 px-2 text-xs"
                            >
                                <Save className="mr-1 size-3.5" />
                                保存
                            </Button>
                            <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                title="取消修改"
                                aria-label="取消修改"
                                disabled={!isValueDraftDirty || isMutating}
                                onClick={onCancelValueDraft}
                                className="size-7"
                            >
                                <Undo2 />
                            </Button>
                        </>
                    ) : null}
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title="刷新当前 key"
                        aria-label="刷新当前 key"
                        disabled={!resolvedKey || isFetching}
                        onClick={onRefreshCurrentKey}
                        className="size-7"
                    >
                        <RefreshCw />
                    </Button>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title="删除 key"
                        aria-label="删除 key"
                        disabled={!resolvedKey || isDeletePending}
                        onClick={onDeleteCurrentKey}
                        className="size-7"
                    >
                        <Trash2 />
                    </Button>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="shrink-0 text-muted-foreground">
                        内存 {formatMemoryUsage(size)}
                    </span>
                    {showStringPreviewModes && (
                        <Tabs
                            value={effectiveStringPreviewMode}
                            onValueChange={onStringPreviewModeChange}
                            className="min-w-0 shrink-0"
                        >
                            <TabsList variant="line" className="h-7">
                                {STRING_PREVIEW_MODES.map((mode) => (
                                    <TabsTrigger
                                        key={mode.value}
                                        value={mode.value}
                                        className="px-2 text-xs"
                                    >
                                        {mode.label}
                                    </TabsTrigger>
                                ))}
                            </TabsList>
                        </Tabs>
                    )}
                    {showCollectionActions && (
                        <div className="flex shrink-0 items-center gap-1">
                            <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                title="添加元素"
                                aria-label="添加元素"
                                disabled={!canAddCollectionRow}
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
                                disabled={!canDeleteCollectionRow}
                                onClick={onDeleteCollectionRow}
                                className="size-7"
                            >
                                <Minus />
                            </Button>
                        </div>
                    )}
                </div>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4">
                {previewContent}
            </div>
            <Separator />
        </section>
    );
}
