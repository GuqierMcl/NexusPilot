import { useEffect, useRef, type FC } from "react";
export interface ComposerMenuItem {
    key: string;
    title: string;
    description: string;
    group?: string;
    choose: () => void;
}
interface ComposerMenuProps {
    id: string;
    kind: "reference" | "command";
    items: ComposerMenuItem[];
    selected: number;
    loading: boolean;
    errors: string[];
    onSelect: (index: number) => void;
    onRetry: () => void;
}
export const ComposerMenu: FC<ComposerMenuProps> = ({
    id,
    kind,
    items,
    selected,
    loading,
    errors,
    onSelect,
    onRetry,
}) => {
    const root = useRef<HTMLDivElement>(null);
    useEffect(() => {
        root.current
            ?.querySelector('[aria-selected="true"]')
            ?.scrollIntoView({ block: "nearest" });
    }, [selected]);
    return (
        <div
            ref={root}
            className="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-full min-w-60 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
            <div className="px-2 py-1 text-xs text-muted-foreground">
                {kind === "reference" ? "引用上下文" : "快捷命令"}
            </div>
            <div
                id={id}
                role="listbox"
                aria-label={kind === "reference" ? "上下文候选" : "命令候选"}
            >
                {items.map((item, index) => (
                    <button
                        key={item.key}
                        id={`${id}-${index}`}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={index === selected}
                        className={`block w-full rounded-md px-2 py-1.5 text-left text-sm ${index === selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => onSelect(index)}
                        onClick={item.choose}
                    >
                        <span className="block truncate">{item.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                            {item.group ? `${item.group} · ` : ""}
                            {item.description}
                        </span>
                    </button>
                ))}
            </div>
            {loading && (
                <div role="status" className="px-2 py-2 text-xs">
                    正在搜索…
                </div>
            )}
            {!loading && !items.length && !errors.length && (
                <div
                    role="status"
                    className="px-2 py-2 text-xs text-muted-foreground"
                >
                    没有匹配项
                </div>
            )}
            {errors.map((error) => (
                <div
                    key={error}
                    role="status"
                    className="px-2 py-1 text-xs text-muted-foreground"
                >
                    {error}
                </div>
            ))}
            {!!errors.length && (
                <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={onRetry}
                    className="px-2 py-1 text-xs underline"
                >
                    刷新来源
                </button>
            )}
        </div>
    );
};
