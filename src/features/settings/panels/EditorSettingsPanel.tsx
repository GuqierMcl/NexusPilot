import { Button } from "@/components/ui/button";
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/features/settings/components/settings-section";
import { DEFAULT_APP_SETTINGS } from "@/config/app-settings";
import { useSettingsStore } from "@/store/slices/settings-slice";
import type {
    EditorLineNumbers,
    EditorRenderWhitespace,
    EditorWordWrap,
} from "@/types/settings";

const WORD_WRAP_OPTIONS: Array<{ value: EditorWordWrap; label: string }> = [
    { value: "on", label: "开启" },
    { value: "off", label: "关闭" },
];

const LINE_NUMBER_OPTIONS: Array<{ value: EditorLineNumbers; label: string }> = [
    { value: "on", label: "显示" },
    { value: "off", label: "隐藏" },
];

const RENDER_WHITESPACE_OPTIONS: Array<{
    value: EditorRenderWhitespace;
    label: string;
}> = [
    { value: "none", label: "不显示" },
    { value: "selection", label: "仅选区" },
    { value: "all", label: "全部显示" },
];

function parseNumberInput(value: string): number | null {
    if (value.trim().length === 0) {
        return null;
    }

    const next = Number.parseInt(value, 10);
    return Number.isFinite(next) ? next : null;
}

export function EditorSettingsPanel() {
    const editor = useSettingsStore((state) => state.editor);
    const setEditorSettings = useSettingsStore((state) => state.setEditorSettings);
    const setEditorFontFamily = useSettingsStore((state) => state.setEditorFontFamily);
    const setEditorFontSize = useSettingsStore((state) => state.setEditorFontSize);
    const setEditorLineHeight = useSettingsStore((state) => state.setEditorLineHeight);
    const setEditorTabSize = useSettingsStore((state) => state.setEditorTabSize);
    const setEditorWordWrap = useSettingsStore((state) => state.setEditorWordWrap);
    const setEditorLineNumbers = useSettingsStore(
        (state) => state.setEditorLineNumbers,
    );
    const setEditorMinimapEnabled = useSettingsStore(
        (state) => state.setEditorMinimapEnabled,
    );
    const setEditorRenderWhitespace = useSettingsStore(
        (state) => state.setEditorRenderWhitespace,
    );

    const handleReset = () => {
        setEditorSettings(DEFAULT_APP_SETTINGS.editor);
    };

    return (
        <div className="flex flex-col gap-6">
            <SettingsSection
                title="字体与排版"
                description="控制编辑器在代码查看和编辑场景下的基础排版表现。"
            >
                <FieldGroup>
                    <Field>
                        <FieldLabel htmlFor="editor-font-family">
                            编辑器字体
                        </FieldLabel>
                        <Input
                            id="editor-font-family"
                            value={editor.fontFamily}
                            onChange={(event) =>
                                setEditorFontFamily(event.target.value)
                            }
                            placeholder="留空使用 Monaco 默认字体"
                        />
                        <FieldDescription>
                            按逗号分隔的字体 fallback 栈；留空时使用 Monaco 自带默认字体。
                        </FieldDescription>
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="editor-font-size">
                            字号（px）
                        </FieldLabel>
                        <Input
                            id="editor-font-size"
                            type="number"
                            min={8}
                            step={1}
                            value={editor.fontSize}
                            onChange={(event) => {
                                const next = parseNumberInput(event.target.value);
                                if (next != null) {
                                    setEditorFontSize(next);
                                }
                            }}
                        />
                        <FieldDescription>
                            影响 Monaco 编辑器的基础字号与展示密度。
                        </FieldDescription>
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="editor-line-height">
                            行高（px）
                        </FieldLabel>
                        <Input
                            id="editor-line-height"
                            type="number"
                            min={12}
                            step={1}
                            value={editor.lineHeight}
                            onChange={(event) => {
                                const next = parseNumberInput(event.target.value);
                                if (next != null) {
                                    setEditorLineHeight(next);
                                }
                            }}
                        />
                        <FieldDescription>
                            用于编辑器文本行的垂直间距，也会影响自动高度预览。
                        </FieldDescription>
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="editor-tab-size">
                            Tab 宽度
                        </FieldLabel>
                        <Input
                            id="editor-tab-size"
                            type="number"
                            min={1}
                            step={1}
                            value={editor.tabSize}
                            onChange={(event) => {
                                const next = parseNumberInput(event.target.value);
                                if (next != null) {
                                    setEditorTabSize(next);
                                }
                            }}
                        />
                        <FieldDescription>
                            影响缩进的显示宽度，不会自动修改已有内容。
                        </FieldDescription>
                    </Field>
                </FieldGroup>
            </SettingsSection>

            <SettingsSection
                title="显示"
                description="控制行号、换行、空白字符与辅助渲染行为。"
            >
                <FieldGroup>
                    <Field>
                        <FieldLabel htmlFor="editor-word-wrap">
                            自动换行
                        </FieldLabel>
                        <Select
                            modal={false}
                            value={editor.wordWrap}
                            items={WORD_WRAP_OPTIONS}
                            onValueChange={(value) =>
                                setEditorWordWrap(value as EditorWordWrap)
                            }
                        >
                            <SelectTrigger id="editor-word-wrap" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {WORD_WRAP_OPTIONS.map((option) => (
                                    <SelectItem
                                        key={option.value}
                                        value={option.value}
                                    >
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <FieldDescription>
                            影响长行是否自动折行显示。
                        </FieldDescription>
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="editor-line-numbers">
                            行号
                        </FieldLabel>
                        <Select
                            modal={false}
                            value={editor.lineNumbers}
                            items={LINE_NUMBER_OPTIONS}
                            onValueChange={(value) =>
                                setEditorLineNumbers(value as EditorLineNumbers)
                            }
                        >
                            <SelectTrigger
                                id="editor-line-numbers"
                                className="w-full"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {LINE_NUMBER_OPTIONS.map((option) => (
                                    <SelectItem
                                        key={option.value}
                                        value={option.value}
                                    >
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <FieldDescription>
                            控制编辑器左侧是否显示行号栏。
                        </FieldDescription>
                    </Field>

                    <Field orientation="horizontal" className="items-center">
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <FieldLabel htmlFor="editor-minimap">
                                Minimap
                            </FieldLabel>
                            <FieldDescription>
                                控制编辑器右侧缩略图的显示状态。
                            </FieldDescription>
                        </div>
                        <Switch
                            id="editor-minimap"
                            checked={editor.minimapEnabled}
                            onCheckedChange={setEditorMinimapEnabled}
                        />
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="editor-render-whitespace">
                            空白字符
                        </FieldLabel>
                        <Select
                            modal={false}
                            value={editor.renderWhitespace}
                            items={RENDER_WHITESPACE_OPTIONS}
                            onValueChange={(value) =>
                                setEditorRenderWhitespace(
                                    value as EditorRenderWhitespace,
                                )
                            }
                        >
                            <SelectTrigger
                                id="editor-render-whitespace"
                                className="w-full"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {RENDER_WHITESPACE_OPTIONS.map((option) => (
                                    <SelectItem
                                        key={option.value}
                                        value={option.value}
                                    >
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <FieldDescription>
                            控制空格、Tab 等不可见字符的渲染粒度。
                        </FieldDescription>
                    </Field>
                </FieldGroup>
            </SettingsSection>

            <div className="flex justify-end">
                <Button type="button" variant="outline" onClick={handleReset}>
                    恢复默认
                </Button>
            </div>
        </div>
    );
}
