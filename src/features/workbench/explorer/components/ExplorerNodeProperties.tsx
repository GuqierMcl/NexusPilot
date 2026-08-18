import type { FC } from "react";

import type { ContainerProperty } from "@/types/ipc";

interface ExplorerNodePropertiesProps {
    properties?: ContainerProperty[];
}

export const ExplorerNodeProperties: FC<ExplorerNodePropertiesProps> = ({
    properties,
}) => {
    if (!properties?.length) return null;

    const [summary, ...details] = properties;
    const title = properties
        .map(({ label, value }) => `${label}: ${value}`)
        .join("\n");

    return (
        <span
            aria-label="对象属性"
            className="ml-auto min-w-0 max-w-40 truncate text-xs text-muted-foreground"
            title={title}
        >
            {summary.label}: {summary.value}
            {details.length > 0 ? (
                <span className="sr-only">
                    {details.map(({ key, label, value }) => (
                        <span key={key}>
                            {label}: {value}
                        </span>
                    ))}
                </span>
            ) : null}
        </span>
    );
};
