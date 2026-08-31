import type { FC, RefObject } from "react";
import { ChevronDown } from "lucide-react";

import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
    ConnectionTagFields,
    type ConnectionTagValue,
} from "@/features/workbench/explorer/components/ConnectionTagFields";
import { buildConnectionMetadataSummary } from "@/features/workbench/explorer/connection-metadata";
import { getConnectionTagColor } from "@/features/workbench/explorer/connection-tags";
import {
    CONNECTION_NOTE_MAX_LENGTH,
    countConnectionNoteCharacters,
    isConnectionNoteWithinLimit,
    normalizeConnectionNote,
} from "@/features/workbench/explorer/connection-notes";
import { cn } from "@/lib/utils";

export interface ConnectionMetadataDisclosureProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    tag: ConnectionTagValue;
    onTagChange: (tag: ConnectionTagValue) => void;
    note: string;
    onNoteChange: (note: string) => void;
    disabled: boolean;
    noteInputRef: RefObject<HTMLTextAreaElement | null>;
}

export const ConnectionMetadataDisclosure: FC<ConnectionMetadataDisclosureProps> = ({
    open,
    onOpenChange,
    tag,
    onTagChange,
    note,
    onNoteChange,
    disabled,
    noteInputRef,
}) => {
    const summary = buildConnectionMetadataSummary({ ...tag, note });
    const summaryColor = getConnectionTagColor(summary.tagColor);
    const normalizedNote = normalizeConnectionNote(note);
    const noteCharacterCount = countConnectionNoteCharacters(normalizedNote);
    const noteTooLong = !isConnectionNoteWithinLimit(note);

    return (
        <div className="shrink-0 border-t pt-3">
            <Collapsible
                open={open}
                onOpenChange={onOpenChange}
                className="overflow-hidden rounded-lg border bg-card"
            >
                <CollapsibleTrigger
                    type="button"
                    className="flex w-full items-center gap-2 bg-muted px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                    <span className="shrink-0 text-sm font-medium">外观与备注</span>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                        {summaryColor && (
                            <span
                                aria-hidden="true"
                                className={cn(
                                    "size-2 shrink-0 rounded-full",
                                    summaryColor.markerClassName,
                                )}
                            />
                        )}
                        <span className="min-w-0 truncate whitespace-nowrap">
                            {summary.text}
                        </span>
                    </div>
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(
                            "size-4 shrink-0 text-muted-foreground transition-transform",
                            open && "rotate-180",
                        )}
                    />
                </CollapsibleTrigger>

                <CollapsibleContent className="border-t bg-card px-3 py-4">
                    <div className="grid gap-4">
                        <ConnectionTagFields
                            value={tag}
                            onChange={onTagChange}
                            disabled={disabled}
                        />

                        <Field className="shrink-0" data-invalid={noteTooLong}>
                            <div className="flex items-center justify-between gap-2">
                                <FieldLabel htmlFor="conn-note">备注</FieldLabel>
                                <span
                                    id="conn-note-count"
                                    className={noteTooLong
                                        ? "text-xs tabular-nums text-destructive"
                                        : "text-xs tabular-nums text-muted-foreground"}
                                >
                                    {noteCharacterCount} / {CONNECTION_NOTE_MAX_LENGTH}
                                </span>
                            </div>
                            <FieldContent>
                                <Textarea
                                    ref={noteInputRef}
                                    id="conn-note"
                                    autoComplete="off"
                                    disabled={disabled}
                                    value={note}
                                    onChange={(event) => onNoteChange(event.target.value)}
                                    placeholder="例如：用途、负责人或环境注意事项"
                                    aria-invalid={noteTooLong}
                                    aria-describedby="conn-note-description conn-note-count"
                                    className="min-h-16 resize-y"
                                />
                                <FieldDescription id="conn-note-description">
                                    支持多行纯文本，最多 {CONNECTION_NOTE_MAX_LENGTH} 个字符。
                                </FieldDescription>
                            </FieldContent>
                        </Field>
                    </div>
                </CollapsibleContent>
            </Collapsible>
        </div>
    );
};
