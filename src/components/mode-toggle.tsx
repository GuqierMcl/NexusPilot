import { Moon, Sun, SunMoon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/provider/theme-provider";
import { useSettingsStore } from "@/store/slices/settings-slice";

export function ModeToggle() {
    const { theme, setTheme } = useTheme();
    const setThemeMode = useSettingsStore((s) => s.setThemeMode);
    const themes = ["light", "dark", "system"] as const;

    const ThemeIcon =
        theme === "system" ? SunMoon : theme === "dark" ? Moon : Sun;
    const handleToggle = () => {
        const currentIndex = themes.indexOf(theme);
        const nextTheme = themes[(currentIndex + 1) % themes.length];

        setTheme(nextTheme);
        setThemeMode(nextTheme);
    };

    return (
        <Button
            variant="ghost"
            size="icon"
            type="button"
            onClick={handleToggle}
            title={`当前模式：${theme}`}
        >
            <ThemeIcon className="h-[1.2rem] w-[1.2rem]" />
        </Button>
    );
}
