import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { DatabaseNameFormValue } from "@/features/workbench/explorer/driver-configs/types";

interface CreateDatabaseNameFormProps {
    value: DatabaseNameFormValue;
    onChange: (value: DatabaseNameFormValue) => void;
    disabled?: boolean;
    label?: string;
    placeholder?: string;
}

export function CreateDatabaseNameForm({
    value,
    onChange,
    disabled,
    label = "数据库名称",
    placeholder = "例如：app",
}: CreateDatabaseNameFormProps) {
    return (
        <Field>
            <FieldLabel htmlFor="create-database-name">{label}</FieldLabel>
            <FieldContent>
                <Input
                    id="create-database-name"
                    autoComplete="off"
                    disabled={disabled}
                    value={value.name}
                    onChange={(event) =>
                        onChange({ ...value, name: event.target.value })
                    }
                    placeholder={placeholder}
                />
            </FieldContent>
        </Field>
    );
}
