export interface CodeEditorDialogStats {
    lineCount: number;
    characterCount: number;
}

export const CODE_EDITOR_DIALOG_CONTENT_CLASS =
    "grid h-[min(820px,calc(100vh-2rem))] w-[calc(100vw-2rem)] max-w-none! grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:w-[min(72vw,1280px)] sm:max-w-none!";

export const CODE_EDITOR_DIALOG_FOOTER_CLASS =
    "flex min-h-12 items-center justify-between gap-3 border-t bg-muted/50 px-4 py-2";

export function getCodeEditorDialogStats(value: string): CodeEditorDialogStats {
    return {
        lineCount: value.length === 0 ? 1 : value.split("\n").length,
        characterCount: value.length,
    };
}

export function shouldConfirmCodeEditorDialogClose(isDirty: boolean): boolean {
    return isDirty;
}

export function validateJsonEditorValue(value: string): string | null {
    try {
        JSON.parse(value);
        return null;
    } catch {
        return "JSON 格式无效";
    }
}

export function formatJsonEditorValue(value: string): string | null {
    try {
        return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
        return null;
    }
}
