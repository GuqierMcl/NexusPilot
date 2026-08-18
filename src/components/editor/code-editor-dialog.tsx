import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { CodeEditor } from "./code-editor";
import {
    CODE_EDITOR_DIALOG_CONTENT_CLASS,
    CODE_EDITOR_DIALOG_FOOTER_CLASS,
    getCodeEditorDialogStats,
    shouldConfirmCodeEditorDialogClose,
    type CodeEditorDialogStats,
} from "./code-editor-dialog-utils";
import type { CodeEditorLanguage, CodeEditorPreset } from "./editor-types";

export interface CodeEditorDialogToolbarContext {
    draftValue: string;
    setDraftValue: (value: string) => void;
    isDirty: boolean;
}

export interface CodeEditorDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: ReactNode;
    value: string;
    language?: CodeEditorLanguage;
    preset?: CodeEditorPreset;
    applyLabel?: string;
    className?: string;
    editorPath?: string;
    toolbarActions?: (context: CodeEditorDialogToolbarContext) => ReactNode;
    validate?: (value: string) => string | null;
    onApply: (value: string) => void;
}

export function CodeEditorDialog({
    open,
    onOpenChange,
    title,
    description,
    value,
    language = "plaintext",
    preset = "default",
    applyLabel = "应用",
    className,
    editorPath,
    toolbarActions,
    validate,
    onApply,
}: CodeEditorDialogProps) {
    const [draftValue, setDraftValue] = useState(value);
    const [validationError, setValidationError] = useState<string | null>(null);
    const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
    const wasOpenRef = useRef(false);

    useEffect(() => {
        if (!open) {
            setDiscardConfirmOpen(false);
        }

        if (open && !wasOpenRef.current) {
            setDraftValue(value);
            setValidationError(null);
            setDiscardConfirmOpen(false);
        }
        wasOpenRef.current = open;
    }, [open, value]);

    const isDirty = draftValue !== value;
    const stats: CodeEditorDialogStats = useMemo(
        () => getCodeEditorDialogStats(draftValue),
        [draftValue],
    );
    const toolbarContent = toolbarActions?.({
        draftValue,
        setDraftValue,
        isDirty,
    });

    const handleRequestClose = () => {
        if (shouldConfirmCodeEditorDialogClose(isDirty)) {
            setDiscardConfirmOpen(true);
            return;
        }

        onOpenChange(false);
    };

    const handleDiscardChanges = () => {
        setDiscardConfirmOpen(false);
        onOpenChange(false);
    };

    const handleApply = () => {
        const nextError = validate?.(draftValue) ?? null;
        setValidationError(nextError);
        if (nextError) return;

        onApply(draftValue);
        onOpenChange(false);
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen, eventDetails) => {
                if (!nextOpen && ["escape-key", "outside-press", "focus-out"].includes(eventDetails.reason)) {
                    eventDetails.cancel();
                    return;
                }
                if (nextOpen) onOpenChange(true);
            }}
        >
            <DialogContent
                showCloseButton={false}
                className={cn(CODE_EDITOR_DIALOG_CONTENT_CLASS, className)}
            >
                <DialogHeader className="border-b px-4 py-3 pr-12">
                    <DialogTitle>{title}</DialogTitle>
                    {description ? (
                        <DialogDescription>{description}</DialogDescription>
                    ) : null}
                    <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="absolute top-2 right-2"
                        title="关闭"
                        aria-label="关闭"
                        onClick={handleRequestClose}
                    >
                        <X />
                    </Button>
                </DialogHeader>

                <div className="flex min-h-10 items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded border bg-background px-1.5 py-0.5 font-mono">
                            {language}
                        </span>
                        <span
                            className={cn(
                                "rounded-full px-2 py-0.5",
                                isDirty
                                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                    : "bg-muted text-muted-foreground",
                            )}
                        >
                            {isDirty ? "已编辑" : "未编辑"}
                        </span>
                    </div>
                    {toolbarContent ? (
                        <div className="flex shrink-0 items-center gap-2">
                            {toolbarContent}
                        </div>
                    ) : null}
                </div>

                <div className="min-h-0 min-w-0 p-3">
                    <CodeEditor
                        value={draftValue}
                        language={language}
                        preset={preset}
                        height="100%"
                        heightMode="fixed"
                        path={editorPath}
                        onChange={(nextValue) => {
                            setDraftValue(nextValue);
                            setValidationError(null);
                        }}
                        className="h-full min-h-0 rounded-md"
                    />
                </div>

                <div className={CODE_EDITOR_DIALOG_FOOTER_CLASS}>
                    <div className="flex min-w-0 flex-1 items-center gap-3 text-xs text-muted-foreground">
                        <span>{stats.lineCount} 行</span>
                        <span>{stats.characterCount} 字符</span>
                        {validationError ? (
                            <span className="truncate text-destructive">
                                {validationError}
                            </span>
                        ) : null}
                    </div>
                    <Button type="button" disabled={!isDirty} onClick={handleApply}>
                        {applyLabel}
                    </Button>
                </div>
            </DialogContent>

            <AlertDialog
                open={discardConfirmOpen}
                onOpenChange={setDiscardConfirmOpen}
            >
                <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>放弃未应用的修改？</AlertDialogTitle>
                        <AlertDialogDescription>
                            当前内容尚未应用，关闭后本次弹窗中的修改会丢失。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>继续编辑</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            onClick={handleDiscardChanges}
                        >
                            放弃修改
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Dialog>
    );
}
