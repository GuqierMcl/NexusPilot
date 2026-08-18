import { useEffect, useState } from "react";

import { useTheme } from "@/components/provider/theme-provider";

export type CodeEditorTheme = "light" | "vs-dark";

function resolveSystemEditorTheme(): CodeEditorTheme {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "vs-dark"
        : "light";
}

export function useEditorTheme(): CodeEditorTheme {
    const { theme } = useTheme();
    const [systemTheme, setSystemTheme] = useState<CodeEditorTheme>(() =>
        resolveSystemEditorTheme(),
    );

    useEffect(() => {
        if (theme !== "system" || typeof window === "undefined") return;

        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const handleChange = () => {
            setSystemTheme(media.matches ? "vs-dark" : "light");
        };

        handleChange();
        media.addEventListener("change", handleChange);
        return () => media.removeEventListener("change", handleChange);
    }, [theme]);

    if (theme === "dark") return "vs-dark";
    if (theme === "light") return "light";
    return systemTheme;
}
