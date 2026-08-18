import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandItem,
    CommandList,
    CommandSeparator,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
    Popover,
    PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { DbDriver } from "@/types";

interface ColumnTypeSelectorProps {
    value: unknown;
    driver?: DbDriver | null;
    rowIndex: number;
    columnId: string;
    onCommit?: (rowIndex: number, columnId: string, value: unknown) => void;
    onCancel?: () => void;
}

interface ColumnTypeOption {
    value: string;
}

const MYSQL_TYPES: ColumnTypeOption[] = [
    { value: "varchar(255)" },
    { value: "text" },
    { value: "int" },
    { value: "bigint" },
    { value: "decimal(10,2)" },
    { value: "datetime" },
    { value: "timestamp" },
    { value: "date" },
    { value: "boolean" },
    { value: "json" },
    { value: "char(36)" },
    { value: "blob" },
];

const POSTGRES_TYPES: ColumnTypeOption[] = [
    { value: "varchar(255)" },
    { value: "text" },
    { value: "integer" },
    { value: "bigint" },
    { value: "numeric(10,2)" },
    { value: "timestamp" },
    { value: "timestamptz" },
    { value: "date" },
    { value: "boolean" },
    { value: "jsonb" },
    { value: "uuid" },
    { value: "bytea" },
];

const GENERIC_TYPES: ColumnTypeOption[] = [
    { value: "varchar(255)" },
    { value: "text" },
    { value: "integer" },
    { value: "bigint" },
    { value: "decimal(10,2)" },
    { value: "timestamp" },
    { value: "date" },
    { value: "boolean" },
    { value: "json" },
];

function typeOptionsForDriver(driver?: DbDriver | null): ColumnTypeOption[] {
    if (driver === "mysql") return MYSQL_TYPES;
    if (driver === "postgres") return POSTGRES_TYPES;
    return GENERIC_TYPES;
}

function driverGroupLabel(driver?: DbDriver | null): string {
    if (driver === "mysql") return "MySQL 常用类型";
    if (driver === "postgres") return "PostgreSQL 常用类型";
    return "常用类型";
}

export function ColumnTypeSelector({
    value,
    driver,
    rowIndex,
    columnId,
    onCommit,
    onCancel,
}: ColumnTypeSelectorProps) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const popoverAnchorRef = useRef<HTMLDivElement | null>(null);
    const skipBlurCommitRef = useRef(false);
    const currentValue = String(value ?? "");
    const [draftValue, setDraftValue] = useState(currentValue);
    const [isDirty, setIsDirty] = useState(false);
    const [open, setOpen] = useState(false);
    const options = useMemo(() => typeOptionsForDriver(driver), [driver]);
    const query = draftValue.trim().toLowerCase();
    const filteredOptions = useMemo(() => {
        if (!query) return options;
        return options.filter((option) => option.value.toLowerCase().includes(query));
    }, [options, query]);
    const hasCurrentOption = options.some(
        (option) => option.value === draftValue.trim(),
    );

    useEffect(() => {
        setDraftValue(currentValue);
        setIsDirty(false);
    }, [currentValue]);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const commit = (nextValue: string) => {
        skipBlurCommitRef.current = true;
        onCommit?.(rowIndex, columnId, nextValue.trim());
        setOpen(false);
    };

    const cancel = () => {
        setDraftValue(currentValue);
        setIsDirty(false);
        onCancel?.();
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
                <div ref={popoverAnchorRef} className="relative w-full">
                    <Input
                        ref={inputRef}
                        className={cn("h-7 rounded-sm px-2 pr-8 text-xs")}
                        value={draftValue}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="输入或选择类型"
                        onFocus={() => setOpen(true)}
                        onChange={(event) => {
                            setDraftValue(event.target.value);
                            setIsDirty(true);
                            setOpen(true);
                        }}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onBlur={() => {
                            if (skipBlurCommitRef.current) {
                                skipBlurCommitRef.current = false;
                                return;
                            }
                            if (isDirty) {
                                commit(draftValue);
                                return;
                            }
                            cancel();
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                commit(draftValue);
                            }
                            if (event.key === "Escape") {
                                event.preventDefault();
                                skipBlurCommitRef.current = true;
                                cancel();
                            }
                        }}
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute top-0.5 right-0.5 size-6"
                        onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                        }}
                        onClick={(event) => {
                            event.stopPropagation();
                            setOpen((current) => !current);
                        }}
                        aria-label="展开类型候选"
                    >
                        <ChevronsUpDown data-icon="inline-end" className="opacity-60" />
                    </Button>
                </div>
            <PopoverContent
                anchor={popoverAnchorRef}
                align="start"
                sideOffset={6}
                className="w-80 p-1.5"
            >
                <Command>
                    <CommandList className="max-h-64">
                        {draftValue.trim().length > 0 && !hasCurrentOption && (
                            <>
                                <CommandGroup heading="当前输入">
                                    <CommandItem
                                        value={`custom::${draftValue}`}
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                        }}
                                        onSelect={() => commit(draftValue)}
                                    >
                                        <span className="truncate">{draftValue}</span>
                                    </CommandItem>
                                </CommandGroup>
                                <CommandSeparator />
                            </>
                        )}

                        <CommandGroup heading={driverGroupLabel(driver)}>
                            {filteredOptions.length > 0 ? (
                                filteredOptions.map((option) => (
                                    <CommandItem
                                        key={option.value}
                                        value={option.value}
                                        data-checked={draftValue.trim() === option.value}
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                        }}
                                        onSelect={() => commit(option.value)}
                                    >
                                        <span className="truncate">{option.value}</span>
                                    </CommandItem>
                                ))
                            ) : (
                                <CommandEmpty>没有匹配的常用类型</CommandEmpty>
                            )}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
