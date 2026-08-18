import type { EditorProps, Monaco, OnMount } from "@monaco-editor/react";

export type CodeEditorLanguage =
    | "plaintext"
    | "sql"
    | "json"
    | "xml"
    | "javascript"
    | "typescript"
    | "markdown"
    | "yaml";

export type CodeEditorHeightMode = "fixed" | "auto";

export type CodeEditorPreset =
    | "default"
    | "sqlEditor"
    | "compactPreview"
    | "largeReadonly"
    | "jsonDocument";

export type CodeEditorOptions = NonNullable<EditorProps["options"]>;

export type CodeEditorOnMount = OnMount;

export type CodeEditorBeforeMount = (monaco: Monaco) => void;
