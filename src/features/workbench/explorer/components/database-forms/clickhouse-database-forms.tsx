import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { DatabaseNameFormValue } from "@/features/workbench/explorer/driver-configs/types";

interface CreateClickHouseDatabaseFormProps {
    value: DatabaseNameFormValue;
    onChange: (value: DatabaseNameFormValue) => void;
    disabled?: boolean;
}

export function CreateClickHouseDatabaseForm({
    value,
    onChange,
    disabled,
}: CreateClickHouseDatabaseFormProps) {
    return (
        <Field>
            <FieldLabel htmlFor="create-clickhouse-database-name">
                数据库名称
            </FieldLabel>
            <FieldContent>
                <Input
                    id="create-clickhouse-database-name"
                    autoComplete="off"
                    disabled={disabled}
                    value={value.name}
                    onChange={(event) =>
                        onChange({ name: event.target.value })
                    }
                    placeholder="例如：analytics"
                />
            </FieldContent>
        </Field>
    );
}
