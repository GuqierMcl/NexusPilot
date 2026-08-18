import type { FC, ReactNode } from "react";

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { SqlExecutionContext } from "@/types/saved-queries";

export interface SqlEditorContextOption {
    value: string;
    label: string;
    database?: string | null;
}

interface SqlEditorContextBarProps {
    connectionName: string;
    context: SqlExecutionContext;
    databaseOptions: SqlEditorContextOption[];
    schemaOptions: SqlEditorContextOption[];
    showDatabase: boolean;
    showSchema: boolean;
    disabled?: boolean;
    rightSlot?: ReactNode;
    onContextChange: (context: SqlExecutionContext) => void;
}

export const SqlEditorContextBar: FC<SqlEditorContextBarProps> = ({
    connectionName,
    context,
    databaseOptions,
    schemaOptions,
    showDatabase,
    showSchema,
    disabled,
    rightSlot,
    onContextChange,
}) => {
    return (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/30 px-2">
            <div className="min-w-0 max-w-56 truncate text-xs text-muted-foreground">
                {connectionName}
            </div>
            {showDatabase && (
                <Select
                    value={context.database ?? ""}
                    items={databaseOptions}
                    disabled={disabled || databaseOptions.length === 0}
                    onValueChange={(database) =>
                        onContextChange({
                            database,
                            schema: null,
                        })
                    }
                >
                    <SelectTrigger className="h-7 w-48 text-xs">
                        <SelectValue placeholder="选择数据库" />
                    </SelectTrigger>
                    <SelectContent>
                        {databaseOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
            {showSchema && (
                <Select
                    value={context.schema ?? ""}
                    items={schemaOptions}
                    disabled={disabled || schemaOptions.length === 0}
                    onValueChange={(schema) => {
                        const option = schemaOptions.find(
                            (item) => item.value === schema,
                        );
                        onContextChange({
                            database: option?.database ?? context.database ?? null,
                            schema,
                        });
                    }}
                >
                    <SelectTrigger className="h-7 w-44 text-xs">
                        <SelectValue placeholder="选择 Schema" />
                    </SelectTrigger>
                    <SelectContent>
                        {schemaOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
            {rightSlot ? (
                <div className="ml-auto min-w-0 max-w-[45%]">{rightSlot}</div>
            ) : null}
        </div>
    );
};
