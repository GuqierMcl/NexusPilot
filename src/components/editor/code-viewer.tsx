import type { FC, ReactNode } from "react";

import type {
    CodeEditorBeforeMount,
    CodeEditorHeightMode,
    CodeEditorLanguage,
    CodeEditorOnMount,
    CodeEditorOptions,
    CodeEditorPreset,
} from "./editor-types";
import { CodeEditor } from "./code-editor";

export interface CodeViewerProps {
    value: string;
    language?: CodeEditorLanguage;
    preset?: CodeEditorPreset;
    height?: number | string;
    heightMode?: CodeEditorHeightMode;
    className?: string;
    path?: string;
    loading?: ReactNode;
    options?: CodeEditorOptions;
    onMount?: CodeEditorOnMount;
    beforeMount?: CodeEditorBeforeMount;
}

export const CodeViewer: FC<CodeViewerProps> = ({
    value,
    language = "plaintext",
    preset = "compactPreview",
    height,
    heightMode = "auto",
    className,
    path,
    loading,
    options,
    onMount,
    beforeMount,
}) => (
    <CodeEditor
        value={value}
        language={language}
        preset={preset}
        readOnly
        height={height}
        heightMode={heightMode}
        className={className}
        path={path}
        loading={loading}
        options={{
            folding: false,
            glyphMargin: false,
            links: false,
            occurrencesHighlight: "off",
            selectionHighlight: false,
            ...options,
        }}
        onMount={onMount}
        beforeMount={beforeMount}
    />
);
