import type { ReactNode } from "react";

import { WindowTitlebar } from "./WindowTitlebar";

type AppTitleBarProps = {
    children: ReactNode;
    center?: ReactNode;
    titleActions?: ReactNode;
    macosContent?: ReactNode;
};

export function AppTitleBar({
    children,
    center,
    titleActions,
    macosContent,
}: AppTitleBarProps) {
    return (
        <WindowTitlebar
            center={center}
            actions={
                titleActions
            }
            macosContent={macosContent}
            className="px-0"
            contentClassName="px-3"
        >
            {children}
        </WindowTitlebar>
    );
}
