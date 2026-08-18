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
import { useTheme } from "@/components/provider/theme-provider";
import { SettingsSection } from "@/features/settings/components/settings-section";
import { applyInterfaceFontFamily } from "@/lib/appearance";
import { useSettingsStore } from "@/store/slices/settings-slice";
import type { ThemeMode } from "@/types/settings";

const THEME_MODE_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
    { value: "system", label: "跟随系统" },
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
];

const LANGUAGE_OPTIONS = [{ value: "system", label: "跟随系统" }];

export function CommonSettingsPanel() {
    const { common, setInterfaceFontFamilyInput, setThemeMode } =
        useSettingsStore();
    const { setTheme } = useTheme();

    const handleThemeChange = (value: string | null) => {
        if (value == null) return;
        const themeMode = value as ThemeMode;
        setTheme(themeMode);
        setThemeMode(themeMode);
    };

    const handleInterfaceFontChange = (
        event: React.ChangeEvent<HTMLInputElement>,
    ) => {
        const value = event.target.value;
        setInterfaceFontFamilyInput(value);
        applyInterfaceFontFamily(value);
    };

    const handleResetInterfaceFont = () => {
        setInterfaceFontFamilyInput("");
        applyInterfaceFontFamily("");
    };

    return (
        <div className="flex flex-col gap-6">
            <SettingsSection title="外观">
                <FieldGroup>
                    <Field>
                        <FieldLabel htmlFor="theme-select">主题模式</FieldLabel>
                        <Select
                            modal={false}
                            value={common.themeMode}
                            items={THEME_MODE_OPTIONS}
                            onValueChange={handleThemeChange}
                        >
                            <SelectTrigger id="theme-select" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {THEME_MODE_OPTIONS.map((option) => (
                                    <SelectItem
                                        key={option.value}
                                        value={option.value}
                                    >
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="interface-font-input">
                            界面字体
                        </FieldLabel>
                        <div className="flex gap-2">
                            <Input
                                id="interface-font-input"
                                value={common.interfaceFontFamilyInput}
                                onChange={handleInterfaceFontChange}
                                placeholder="Geist Variable, Microsoft YaHei UI, sans-serif"
                            />
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handleResetInterfaceFont}
                            >
                                恢复默认
                            </Button>
                        </div>
                        <FieldDescription>
                            按顺序尝试逗号分隔的字体；未安装时自动使用后续字体，留空使用默认字体。
                        </FieldDescription>
                    </Field>
                </FieldGroup>
            </SettingsSection>

            <SettingsSection title="语言">
                <FieldGroup>
                    <Field>
                        <FieldLabel htmlFor="language-select">界面语言</FieldLabel>
                        <Select
                            modal={false}
                            value={common.language}
                            items={LANGUAGE_OPTIONS}
                            disabled
                        >
                            <SelectTrigger id="language-select" className="w-full">
                                <SelectValue placeholder="跟随系统" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="system">跟随系统</SelectItem>
                            </SelectContent>
                        </Select>
                        <FieldDescription>多语言支持正在开发中</FieldDescription>
                    </Field>
                </FieldGroup>
            </SettingsSection>
        </div>
    );
}
