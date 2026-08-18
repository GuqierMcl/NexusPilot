import { describe, expect, test } from "bun:test";

import {
    CODE_EDITOR_DIALOG_CONTENT_CLASS,
    CODE_EDITOR_DIALOG_FOOTER_CLASS,
    formatJsonEditorValue,
    getCodeEditorDialogStats,
    shouldConfirmCodeEditorDialogClose,
    validateJsonEditorValue,
} from "../../../src/components/editor/code-editor-dialog-utils";

describe("code editor dialog utilities", () => {
    test("counts empty content as one editable line", () => {
        expect(getCodeEditorDialogStats("")).toEqual({
            lineCount: 1,
            characterCount: 0,
        });
    });

    test("counts lines and characters for multiline content", () => {
        expect(getCodeEditorDialogStats("alpha\nbeta")).toEqual({
            lineCount: 2,
            characterCount: 10,
        });
    });

    test("validates JSON text", () => {
        expect(validateJsonEditorValue('{"ok":true}')).toBeNull();
        expect(validateJsonEditorValue("{bad")).toBe("JSON 格式无效");
    });

    test("formats JSON text without swallowing invalid input", () => {
        expect(formatJsonEditorValue('{"ok":true}')).toBe('{\n  "ok": true\n}');
        expect(formatJsonEditorValue("{bad")).toBeNull();
    });

    test("requires close confirmation only after local edits", () => {
        expect(shouldConfirmCodeEditorDialogClose(false)).toBe(false);
        expect(shouldConfirmCodeEditorDialogClose(true)).toBe(true);
    });

    test("uses a wide responsive desktop dialog layout", () => {
        expect(CODE_EDITOR_DIALOG_CONTENT_CLASS).toContain(
            "w-[calc(100vw-2rem)]",
        );
        expect(CODE_EDITOR_DIALOG_CONTENT_CLASS).toContain(
            "sm:w-[min(72vw,1280px)]",
        );
        expect(CODE_EDITOR_DIALOG_CONTENT_CLASS).toContain("max-w-none!");
        expect(CODE_EDITOR_DIALOG_CONTENT_CLASS).toContain("sm:max-w-none!");
    });

    test("keeps dialog footer controls inset from rounded edges", () => {
        expect(CODE_EDITOR_DIALOG_FOOTER_CLASS).toContain("px-4");
        expect(CODE_EDITOR_DIALOG_FOOTER_CLASS).toContain("py-2");
        expect(CODE_EDITOR_DIALOG_FOOTER_CLASS).not.toContain("-mx-4");
        expect(CODE_EDITOR_DIALOG_FOOTER_CLASS).not.toContain("-mb-4");
    });
});
