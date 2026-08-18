import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
    CONNECTION_TAG_COLORS,
    CONNECTION_TAG_LABEL_MAX_LENGTH,
    DEFAULT_CONNECTION_TAG_COLOR,
    normalizeConnectionTagInput,
} from "@/features/workbench/explorer/connection-tags";
import { cn } from "@/lib/utils";
import type { ConnectionTagColor } from "@/types";

export type ConnectionTagValue = {
    tagLabel: string;
    tagColor: ConnectionTagColor | null;
};

type ConnectionTagFieldsProps = {
    value: ConnectionTagValue;
    onChange: (value: ConnectionTagValue) => void;
    disabled?: boolean;
};

export function ConnectionTagFields({
    value,
    onChange,
    disabled,
}: ConnectionTagFieldsProps) {
    const normalized = normalizeConnectionTagInput(value);

    function update(next: Partial<ConnectionTagValue>) {
        onChange(normalizeConnectionTagInput({ ...value, ...next }));
    }

    function handleLabelChange(nextLabel: string) {
        const next = normalizeConnectionTagInput({
            tagLabel: nextLabel,
            tagColor: value.tagColor ?? (nextLabel.trim() ? DEFAULT_CONNECTION_TAG_COLOR : null),
        });
        onChange(next);
    }

    function handleColorClick(color: ConnectionTagColor) {
        update({
            tagColor: normalized.tagColor === color && !normalized.tagLabel
                ? null
                : color,
        });
    }

    function handleClear() {
        onChange({ tagLabel: "", tagColor: null });
    }

    return (
        <Field>
            <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="conn-tag-label">标签</FieldLabel>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={disabled || (!normalized.tagLabel && !normalized.tagColor)}
                    onClick={handleClear}
                    aria-label="清除标签"
                >
                    <X />
                </Button>
            </div>
            <FieldContent>
                <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
                    <div
                        className="grid grid-cols-9 gap-1.5 sm:justify-start"
                        aria-label="标签颜色"
                    >
                        {CONNECTION_TAG_COLORS.map((color) => {
                            const selected = normalized.tagColor === color.value;
                            return (
                                <button
                                    key={color.value}
                                    type="button"
                                    disabled={disabled}
                                    className={cn(
                                        "flex size-6 items-center justify-center rounded border border-transparent transition-colors",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                                        selected && "border-foreground/30 bg-muted",
                                    )}
                                    onClick={() => handleColorClick(color.value)}
                                    aria-label={`选择${color.label}标签`}
                                    aria-pressed={selected}
                                >
                                    <span
                                        className={cn(
                                            "size-3.5 rounded-full ring-1 ring-background",
                                            color.swatchClassName,
                                        )}
                                    />
                                </button>
                            );
                        })}
                    </div>

                    <Input
                        id="conn-tag-label"
                        autoComplete="off"
                        disabled={disabled}
                        value={normalized.tagLabel}
                        maxLength={CONNECTION_TAG_LABEL_MAX_LENGTH}
                        onChange={(event) => handleLabelChange(event.target.value)}
                        placeholder="0-8 字"
                    />
                </div>
            </FieldContent>
        </Field>
    );
}
