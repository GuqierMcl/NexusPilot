import { Editor } from "@monaco-editor/react";
import type { FC, ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import { useSettingsStore } from "@/store/slices/settings-slice";
import { cn } from "@/lib/utils";

import {
    buildCodeEditorOptions,
    resolveCodeEditorHeight,
    resolveMonacoLanguage,
} from "./editor-settings";
import type {
    CodeEditorBeforeMount,
    CodeEditorHeightMode,
    CodeEditorLanguage,
    CodeEditorOnMount,
    CodeEditorOptions,
    CodeEditorPreset,
} from "./editor-types";
import { useEditorTheme } from "./use-editor-theme";

export interface CodeEditorProps {
    value?: string;
    defaultValue?: string;
    language?: CodeEditorLanguage;
    preset?: CodeEditorPreset;
    readOnly?: boolean;
    height?: number | string;
    heightMode?: CodeEditorHeightMode;
    className?: string;
    path?: string;
    loading?: ReactNode;
    options?: CodeEditorOptions;
    onChange?: (value: string) => void;
    onMount?: CodeEditorOnMount;
    beforeMount?: CodeEditorBeforeMount;
}

function DefaultEditorLoading() {
    return (
        <div className="flex h-full min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            加载编辑器...
        </div>
    );
}

export const CodeEditor: FC<CodeEditorProps> = ({
    value,
    defaultValue,
    language = "plaintext",
    preset = "default",
    readOnly = false,
    height,
    heightMode = "fixed",
    className,
    path,
    loading,
    options,
    onChange,
    onMount,
    beforeMount,
}) => {
    const editorSettings = useSettingsStore((state) => state.editor);
    const theme = useEditorTheme();
    const resolvedValue = value ?? defaultValue ?? "";
    const resolvedHeight = resolveCodeEditorHeight({
        value: resolvedValue,
        settings: editorSettings,
        height,
        heightMode,
    });
    const resolvedOptions = buildCodeEditorOptions({
        settings: editorSettings,
        readOnly,
        heightMode,
        preset,
        options,
    });

    return (
        <div
            className={cn(
                "min-h-0 min-w-0 overflow-hidden rounded-md border bg-background",
                className,
            )}
        >
            <Editor
                value={value}
                defaultValue={defaultValue}
                language={resolveMonacoLanguage(language)}
                path={path}
                theme={theme}
                height={resolvedHeight}
                width="100%"
                loading={loading ?? <DefaultEditorLoading />}
                options={resolvedOptions}
                onChange={(nextValue) => onChange?.(nextValue ?? "")}
                onMount={onMount}
                beforeMount={beforeMount}
            />
        </div>
    );
};
