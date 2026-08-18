import { PanelsTopLeft } from "lucide-react";

import type { ContentToolbarAction } from "@/store";

interface BuildClickHouseSessionViewsActionInput {
    driverName: string;
    disabled: boolean;
    onOpen: () => void;
}

export function buildClickHouseSessionViewsAction(
    input: BuildClickHouseSessionViewsActionInput,
): ContentToolbarAction | null {
    if (input.driverName !== "clickhouse") return null;
    return {
        id: "clickhouse.sessionViews",
        icon: PanelsTopLeft,
        label: "Session Views",
        title: "查看或创建当前 ClickHouse HTTP session 的 Temporary Views",
        disabled: input.disabled,
        onClick: input.onOpen,
    };
}
