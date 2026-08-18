import type { FC, ReactNode } from "react";

import { CodeEditor, type CodeEditorLanguage, type CodeEditorPreset } from "@/components/editor";
import { RedisEditableDataTable } from "@/components/data-table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { RedisEditableValue, RedisValue } from "@/types/ipc";

export const STRING_PREVIEW_MODES = [
    { value: "text", label: "文本" },
    { value: "json", label: "JSON" },
    { value: "xml", label: "XML" },
] as const;

export type StringPreviewMode = (typeof STRING_PREVIEW_MODES)[number]["value"];

type EditablePreviewValue = Extract<
    RedisEditableValue,
    { kind: "string" | "json" | "hash" | "list" | "set" | "sorted_set" | "stream" }
>;

interface RedisValuePreviewProps {
    value: RedisValue | undefined;
    stringPreviewMode: StringPreviewMode;
    isActive?: boolean;
    editableValueDraft?: EditablePreviewValue;
    selectedCollectionRowIndex?: number | null;
    validationError?: string | null;
    onEditableValueDraftChange?: (value: EditablePreviewValue) => void;
    onSelectedCollectionRowIndexChange?: (rowIndex: number | null) => void;
}

interface RedisStringPreviewProps {
    value: RedisValue & { kind: "string" };
    mode: StringPreviewMode;
    isActive?: boolean;
    draftValue?: string;
    onDraftChange?: (value: string) => void;
}

interface RedisJsonPreviewProps {
    value: string;
    isActive?: boolean;
    draftValue?: string;
    onDraftChange?: (value: string) => void;
}

type EditableHashValue = Extract<RedisEditableValue, { kind: "hash" }>;
type EditableListValue = Extract<RedisEditableValue, { kind: "list" }>;
type EditableSetValue = Extract<RedisEditableValue, { kind: "set" }>;
type EditableSortedSetValue = Extract<RedisEditableValue, { kind: "sorted_set" }>;
type EditableStreamValue = Extract<RedisEditableValue, { kind: "stream" }>;

interface ReadonlyValueTextareaProps {
    value: string;
    className?: string;
}

export const ReadonlyValueTextarea: FC<ReadonlyValueTextareaProps> = ({
    value,
    className,
}) => (
    <Textarea
        readOnly
        value={value}
        spellCheck={false}
        className={cn(
            "h-full min-h-0 flex-1 resize-none overflow-auto field-sizing-fixed font-mono text-xs leading-relaxed",
            className,
        )}
    />
);

function renderPreviewWithError(message: string, content: string): ReactNode {
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <p className="text-xs text-destructive">{message}</p>
            <ReadonlyValueTextarea value={content} />
        </div>
    );
}

export function formatJsonContent(content: string): string {
    return JSON.stringify(JSON.parse(content), null, 2);
}

export function formatXmlContent(content: string): string {
    const document = new DOMParser().parseFromString(content, "application/xml");
    const parserError = document.querySelector("parsererror");

    if (parserError) {
        throw new Error(parserError.textContent ?? "Invalid XML");
    }

    const serialized = new XMLSerializer().serializeToString(document);
    const normalized = serialized.replace(/>\s*</g, ">\n<");
    let depth = 0;

    return normalized
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
            if (/^<\//.test(line)) {
                depth = Math.max(depth - 1, 0);
            }

            const next = `${"  ".repeat(depth)}${line}`;
            const isOpeningTag =
                /^<[^!?/][^>]*[^/]>\s*$/.test(line) && !/<\/[^>]+>$/.test(line);

            if (isOpeningTag) {
                depth += 1;
            }

            return next;
        })
        .join("\n");
}

export function formatStringPreviewContent(
    content: string,
    mode: StringPreviewMode,
): { content: string; error: string | null } {
    switch (mode) {
        case "json":
            try {
                return { content: formatJsonContent(content), error: null };
            } catch {
                return {
                    content,
                    error: "JSON 解析失败，显示原始文本",
                };
            }
        case "xml":
            try {
                return { content: formatXmlContent(content), error: null };
            } catch {
                return {
                    content,
                    error: "XML 解析失败，显示原始文本",
                };
            }
        case "text":
        default:
            return { content, error: null };
    }
}

function getStringPreviewLanguage(mode: StringPreviewMode): CodeEditorLanguage {
    switch (mode) {
        case "json":
            return "json";
        case "xml":
            return "xml";
        case "text":
        default:
            return "plaintext";
    }
}

function getStringPreviewPreset(mode: StringPreviewMode): CodeEditorPreset {
    return mode === "json" ? "jsonDocument" : "default";
}

function canParseXml(content: string): boolean {
    const document = new DOMParser().parseFromString(content, "application/xml");
    return document.querySelector("parsererror") == null;
}

export function isUtf8RedisStringValue(value: RedisValue | undefined): boolean {
    return value?.kind === "string" && value.value.encoding === "utf8";
}

export function detectStringPreviewMode(
    value: RedisValue & { kind: "string" },
): StringPreviewMode {
    if (value.value.encoding === "binary") return "text";

    const content = value.value.value ?? "";
    const trimmed = content.trim();

    if (trimmed.length === 0) return "text";

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            JSON.parse(trimmed);
            return "json";
        } catch {
            return "text";
        }
    }

    if (trimmed.startsWith("<") && canParseXml(trimmed)) {
        return "xml";
    }

    return "text";
}

export function resolveStringPreviewMode(
    value: RedisValue | undefined,
    selectedMode: StringPreviewMode | null,
): StringPreviewMode {
    if (selectedMode != null) return selectedMode;
    if (value?.kind !== "string") return "text";
    return detectStringPreviewMode(value);
}

export const RedisBinaryPreview: FC<{ byteLength: number; previewHex: string }> = ({
    byteLength,
    previewHex,
}) => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm text-muted-foreground">
            二进制内容，{byteLength} bytes，无法按文本 / JSON / XML 解析
        </p>
        <ReadonlyValueTextarea value={previewHex} />
    </div>
);

export const RedisStringPreview: FC<RedisStringPreviewProps> = ({
    value,
    mode,
    isActive = true,
    draftValue,
    onDraftChange,
}) => {
    if (value.value.encoding === "binary") {
        return (
            <RedisBinaryPreview
                byteLength={value.value.byteLength}
                previewHex={value.value.previewHex}
            />
        );
    }

    const content = value.value.value ?? "";
    const formatted = formatStringPreviewContent(content, mode);
    const isEditable = draftValue != null && onDraftChange != null;

    if (isEditable) {
        if (!isActive) {
            return <div className="h-full min-h-0 flex-1 rounded-md border bg-background" />;
        }

        return (
            <div className="flex h-full min-h-0 flex-1 flex-col gap-2">
                {formatted.error ? (
                    <p className="text-xs text-destructive">{formatted.error}</p>
                ) : null}
                <CodeEditor
                    value={draftValue}
                    language={getStringPreviewLanguage(mode)}
                    preset={getStringPreviewPreset(mode)}
                    height="100%"
                    heightMode="fixed"
                    onChange={onDraftChange}
                    className="h-full min-h-0 flex-1"
                />
            </div>
        );
    }

    switch (mode) {
        case "json":
        case "xml":
            return formatted.error ? (
                renderPreviewWithError(formatted.error, formatted.content)
            ) : (
                <ReadonlyValueTextarea value={formatted.content} />
            );
        case "text":
        default:
            return <ReadonlyValueTextarea value={content} />;
    }
};

export const RedisJsonPreview: FC<RedisJsonPreviewProps> = ({
    value,
    isActive = true,
    draftValue,
    onDraftChange,
}) => {
    const isEditable = draftValue != null && onDraftChange != null;
    let content = draftValue ?? value;

    if (draftValue == null) {
        try {
            content = formatJsonContent(value);
        } catch {
            content = value;
        }
    }

    if (!isActive) {
        return <div className="h-full min-h-0 flex-1 rounded-md border bg-background" />;
    }

    return (
        <CodeEditor
            value={content}
            language="json"
            preset="jsonDocument"
            readOnly={!isEditable}
            height="100%"
            heightMode="fixed"
            onChange={isEditable ? onDraftChange : undefined}
            className="h-full min-h-0 flex-1"
        />
    );
};

export const RedisHashPreview: FC<{
    value: Extract<RedisValue, { kind: "hash" }>["value"];
    draftValue?: EditableHashValue;
    onDraftChange?: (value: EditableHashValue) => void;
    selectedRowIndex?: number | null;
    onSelectedRowIndexChange?: (rowIndex: number | null) => void;
}> = ({
    value,
    draftValue,
    onDraftChange,
    selectedRowIndex,
    onSelectedRowIndexChange,
}) => (
    <RedisEditableDataTable
        value={draftValue ?? { kind: "hash", value }}
        selectedRowIndex={selectedRowIndex}
        onSelectedRowIndexChange={onSelectedRowIndexChange}
        onChange={
            onDraftChange
                ? (nextValue) => {
                      if (nextValue.kind === "hash") onDraftChange(nextValue);
                  }
                : undefined
        }
    />
);

export const RedisListPreview: FC<{
    value: Extract<RedisValue, { kind: "list" }>["value"];
    draftValue?: EditableListValue;
    onDraftChange?: (value: EditableListValue) => void;
    selectedRowIndex?: number | null;
    onSelectedRowIndexChange?: (rowIndex: number | null) => void;
}> = ({
    value,
    draftValue,
    onDraftChange,
    selectedRowIndex,
    onSelectedRowIndexChange,
}) => (
    <RedisEditableDataTable
        value={draftValue ?? { kind: "list", value }}
        selectedRowIndex={selectedRowIndex}
        onSelectedRowIndexChange={onSelectedRowIndexChange}
        onChange={
            onDraftChange
                ? (nextValue) => {
                      if (nextValue.kind === "list") onDraftChange(nextValue);
                  }
                : undefined
        }
    />
);

export const RedisSetPreview: FC<{
    value: Extract<RedisValue, { kind: "set" }>["value"];
    draftValue?: EditableSetValue;
    onDraftChange?: (value: EditableSetValue) => void;
    selectedRowIndex?: number | null;
    onSelectedRowIndexChange?: (rowIndex: number | null) => void;
}> = ({
    value,
    draftValue,
    onDraftChange,
    selectedRowIndex,
    onSelectedRowIndexChange,
}) => (
    <RedisEditableDataTable
        value={draftValue ?? { kind: "set", value }}
        selectedRowIndex={selectedRowIndex}
        onSelectedRowIndexChange={onSelectedRowIndexChange}
        onChange={
            onDraftChange
                ? (nextValue) => {
                      if (nextValue.kind === "set") onDraftChange(nextValue);
                  }
                : undefined
        }
    />
);

export const RedisSortedSetPreview: FC<{
    value: Extract<RedisValue, { kind: "sorted_set" }>["value"];
    draftValue?: EditableSortedSetValue;
    onDraftChange?: (value: EditableSortedSetValue) => void;
    selectedRowIndex?: number | null;
    onSelectedRowIndexChange?: (rowIndex: number | null) => void;
}> = ({
    value,
    draftValue,
    onDraftChange,
    selectedRowIndex,
    onSelectedRowIndexChange,
}) => (
    <RedisEditableDataTable
        value={draftValue ?? { kind: "sorted_set", value }}
        selectedRowIndex={selectedRowIndex}
        onSelectedRowIndexChange={onSelectedRowIndexChange}
        onChange={
            onDraftChange
                ? (nextValue) => {
                      if (nextValue.kind === "sorted_set") onDraftChange(nextValue);
                  }
                : undefined
        }
    />
);

export const RedisStreamPreview: FC<{
    value: Extract<RedisValue, { kind: "stream" }>["value"];
    draftValue?: EditableStreamValue;
    onDraftChange?: (value: EditableStreamValue) => void;
    selectedRowIndex?: number | null;
    onSelectedRowIndexChange?: (rowIndex: number | null) => void;
}> = ({
    value,
    draftValue,
    onDraftChange,
    selectedRowIndex,
    onSelectedRowIndexChange,
}) => (
    <RedisEditableDataTable
        value={draftValue ?? { kind: "stream", value }}
        selectedRowIndex={selectedRowIndex}
        onSelectedRowIndexChange={onSelectedRowIndexChange}
        onChange={
            onDraftChange
                ? (nextValue) => {
                      if (nextValue.kind === "stream") onDraftChange(nextValue);
                  }
                : undefined
        }
    />
);

export const RedisUnsupportedPreview: FC<{ value: string }> = ({ value }) => (
    <p className="text-sm text-muted-foreground">
        暂不支持预览 {value} 类型
    </p>
);

export const RedisValuePreview: FC<RedisValuePreviewProps> = ({
    value,
    stringPreviewMode,
    isActive = true,
    editableValueDraft,
    selectedCollectionRowIndex,
    validationError,
    onEditableValueDraftChange,
    onSelectedCollectionRowIndexChange,
}) => {
    if (!value) {
        return (
            <p className="text-sm text-muted-foreground">
                选择一个 key 查看内容
            </p>
        );
    }

    const validationMessage = validationError ? (
        <p className="text-xs text-destructive">{validationError}</p>
    ) : null;

    function withValidation(content: ReactNode): ReactNode {
        return validationMessage ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
                {validationMessage}
                {content}
            </div>
        ) : (
            content
        );
    }

    switch (value.kind) {
        case "string":
            return withValidation(
                <RedisStringPreview
                    value={value}
                    mode={stringPreviewMode}
                    isActive={isActive}
                    draftValue={
                        editableValueDraft?.kind === "string"
                            ? editableValueDraft.value
                            : undefined
                    }
                    onDraftChange={
                        editableValueDraft?.kind === "string" &&
                        onEditableValueDraftChange
                            ? (nextValue) =>
                                  onEditableValueDraftChange({
                                      kind: "string",
                                      value: nextValue,
                                  })
                            : undefined
                    }
                />,
            );
        case "json":
            return withValidation(
                <RedisJsonPreview
                    value={value.value}
                    isActive={isActive}
                    draftValue={
                        editableValueDraft?.kind === "json"
                            ? editableValueDraft.value
                            : undefined
                    }
                    onDraftChange={
                        editableValueDraft?.kind === "json" &&
                        onEditableValueDraftChange
                            ? (nextValue) =>
                                  onEditableValueDraftChange({
                                      kind: "json",
                                      value: nextValue,
                                  })
                            : undefined
                    }
                />,
            );
        case "hash":
            return withValidation(
                <RedisHashPreview
                    value={value.value}
                    draftValue={
                        editableValueDraft?.kind === "hash"
                            ? editableValueDraft
                            : undefined
                    }
                    onDraftChange={onEditableValueDraftChange}
                    selectedRowIndex={selectedCollectionRowIndex}
                    onSelectedRowIndexChange={onSelectedCollectionRowIndexChange}
                />,
            );
        case "list":
            return withValidation(
                <RedisListPreview
                    value={value.value}
                    draftValue={
                        editableValueDraft?.kind === "list"
                            ? editableValueDraft
                            : undefined
                    }
                    onDraftChange={onEditableValueDraftChange}
                    selectedRowIndex={selectedCollectionRowIndex}
                    onSelectedRowIndexChange={onSelectedCollectionRowIndexChange}
                />,
            );
        case "set":
            return withValidation(
                <RedisSetPreview
                    value={value.value}
                    draftValue={
                        editableValueDraft?.kind === "set"
                            ? editableValueDraft
                            : undefined
                    }
                    onDraftChange={onEditableValueDraftChange}
                    selectedRowIndex={selectedCollectionRowIndex}
                    onSelectedRowIndexChange={onSelectedCollectionRowIndexChange}
                />,
            );
        case "sorted_set":
            return withValidation(
                <RedisSortedSetPreview
                    value={value.value}
                    draftValue={
                        editableValueDraft?.kind === "sorted_set"
                            ? editableValueDraft
                            : undefined
                    }
                    onDraftChange={onEditableValueDraftChange}
                    selectedRowIndex={selectedCollectionRowIndex}
                    onSelectedRowIndexChange={onSelectedCollectionRowIndexChange}
                />,
            );
        case "stream":
            return withValidation(
                <RedisStreamPreview
                    value={value.value}
                    draftValue={
                        editableValueDraft?.kind === "stream"
                            ? editableValueDraft
                            : undefined
                    }
                    onDraftChange={onEditableValueDraftChange}
                    selectedRowIndex={selectedCollectionRowIndex}
                    onSelectedRowIndexChange={onSelectedCollectionRowIndexChange}
                />,
            );
        case "unsupported":
            return <RedisUnsupportedPreview value={value.value} />;
    }
};
