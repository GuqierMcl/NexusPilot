import type { AppSettingsEditor } from "@/types/settings";

import type {
    CodeEditorHeightMode,
    CodeEditorLanguage,
    CodeEditorOptions,
    CodeEditorPreset,
} from "./editor-types";

const DEFAULT_AUTO_HEIGHT_LINE_LIMIT = 80;
const DEFAULT_AUTO_HEIGHT_MIN_LINES = 8;

export function resolveMonacoLanguage(language: CodeEditorLanguage): string {
    switch (language) {
        case "plaintext":
            return "plaintext";
        case "sql":
            return "sql";
        case "json":
            return "json";
        case "xml":
            return "xml";
        case "javascript":
            return "javascript";
        case "typescript":
            return "typescript";
        case "markdown":
            return "markdown";
        case "yaml":
            return "yaml";
    }
}

export function resolveCodeEditorHeight({
    value,
    settings,
    height,
    heightMode,
    maxAutoLines = DEFAULT_AUTO_HEIGHT_LINE_LIMIT,
    minAutoLines = DEFAULT_AUTO_HEIGHT_MIN_LINES,
}: {
    value: string;
    settings: AppSettingsEditor;
    height?: number | string;
    heightMode: CodeEditorHeightMode;
    maxAutoLines?: number;
    minAutoLines?: number;
}): number | string {
    if (heightMode === "fixed") {
        return height ?? "100%";
    }

    const lineCount = Math.max(value.split("\n").length, minAutoLines);
    const cappedLineCount = Math.min(lineCount, maxAutoLines);
    return cappedLineCount * settings.lineHeight + 24;
}

export function buildCodeEditorOptions({
    settings,
    readOnly,
    heightMode,
    preset,
    options,
}: {
    settings: AppSettingsEditor;
    readOnly: boolean;
    heightMode: CodeEditorHeightMode;
    preset: CodeEditorPreset;
    options?: CodeEditorOptions;
}): CodeEditorOptions {
    const presetOptions = getCodeEditorPresetOptions(preset);
    const { minimap: presetMinimap, scrollbar: presetScrollbar, ...restPresetOptions } =
        presetOptions;
    const { minimap: optionMinimap, scrollbar: optionScrollbar, ...restOptions } =
        options ?? {};
    const baseScrollbar: NonNullable<CodeEditorOptions["scrollbar"]> =
        heightMode === "auto"
            ? {
                  vertical: "hidden",
                  horizontal: "auto",
                  handleMouseWheel: false,
                  alwaysConsumeMouseWheel: false,
              }
            : {
                  alwaysConsumeMouseWheel: false,
              };
    const fontFamily = settings.fontFamily.trim();

    return {
        automaticLayout: true,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        tabSize: settings.tabSize,
        insertSpaces: true,
        wordWrap: settings.wordWrap,
        lineNumbers: settings.lineNumbers,
        renderWhitespace: settings.renderWhitespace,
        readOnly,
        domReadOnly: readOnly,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        contextmenu: true,
        fixedOverflowWidgets: true,
        renderLineHighlight: readOnly ? "none" : "line",
        cursorBlinking: readOnly ? "solid" : "blink",
        overviewRulerBorder: false,
        ...(fontFamily ? { fontFamily } : {}),
        ...restPresetOptions,
        ...restOptions,
        minimap: {
            enabled: settings.minimapEnabled,
            ...presetMinimap,
            ...optionMinimap,
        },
        scrollbar: {
            ...baseScrollbar,
            ...presetScrollbar,
            ...optionScrollbar,
        },
    };
}

export function getCodeEditorPresetOptions(
    preset: CodeEditorPreset,
): CodeEditorOptions {
    switch (preset) {
        case "sqlEditor":
            return {
                folding: true,
                glyphMargin: true,
                hover: { enabled: true },
                links: true,
                lineNumbersMinChars: 4,
                renderLineHighlight: "line",
                stickyScroll: { enabled: true },
            };
        case "compactPreview":
            return {
                codeLens: false,
                folding: false,
                glyphMargin: false,
                hover: { enabled: false },
                lineNumbersMinChars: 3,
                links: false,
                occurrencesHighlight: "off",
                selectionHighlight: false,
                stickyScroll: { enabled: false },
            };
        case "largeReadonly":
            return {
                codeLens: false,
                folding: true,
                glyphMargin: false,
                hover: { enabled: false },
                links: false,
                minimap: { enabled: false },
                occurrencesHighlight: "off",
                selectionHighlight: false,
                stickyScroll: { enabled: false },
            };
        case "jsonDocument":
            return {
                bracketPairColorization: { enabled: true },
                folding: true,
                glyphMargin: false,
                links: false,
                matchBrackets: "always",
                stickyScroll: { enabled: false },
            };
        case "default":
        default:
            return {};
    }
}
