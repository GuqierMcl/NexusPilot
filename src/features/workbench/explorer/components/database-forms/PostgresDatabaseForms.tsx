import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CreateDatabaseNameForm } from "@/features/workbench/explorer/components/CreateDatabaseNameForm";
import type {
    DatabaseMutationContext,
    PostgresCreateDatabaseFormValue,
    PostgresEditDatabaseFormValue,
} from "@/features/workbench/explorer/driver-configs/types";

interface CreatePostgresDatabaseFormProps {
    value: PostgresCreateDatabaseFormValue;
    onChange: (value: PostgresCreateDatabaseFormValue) => void;
    disabled?: boolean;
}

export function CreatePostgresDatabaseForm({
    value,
    onChange,
    disabled,
}: CreatePostgresDatabaseFormProps) {
    return (
        <CreateDatabaseNameForm
            value={value}
            onChange={onChange}
            disabled={disabled}
        />
    );
}

interface EditPostgresDatabaseFormProps {
    value: PostgresEditDatabaseFormValue;
    onChange: (value: PostgresEditDatabaseFormValue) => void;
    disabled?: boolean;
    context: DatabaseMutationContext;
}

export function EditPostgresDatabaseForm({
    value,
    onChange,
    disabled,
}: EditPostgresDatabaseFormProps) {
    return (
        <div className="flex flex-col gap-4">
            <CreateDatabaseNameForm
                value={value}
                onChange={(nextValue) => onChange({ ...value, ...nextValue })}
                disabled={disabled}
            />
            <Field>
                <FieldLabel htmlFor="edit-database-comment">注释</FieldLabel>
                <FieldContent>
                    <Textarea
                        id="edit-database-comment"
                        disabled={disabled}
                        value={value.comment}
                        onChange={(event) =>
                            onChange({ ...value, comment: event.target.value })
                        }
                        placeholder="可选：为数据库设置说明"
                        className="min-h-24 resize-none"
                    />
                </FieldContent>
            </Field>
            <Field>
                <FieldLabel htmlFor="edit-database-tablespace">表空间</FieldLabel>
                <FieldContent>
                    <Input
                        id="edit-database-tablespace"
                        autoComplete="off"
                        disabled={disabled}
                        value={value.tablespace}
                        onChange={(event) =>
                            onChange({
                                ...value,
                                tablespace: event.target.value,
                            })
                        }
                        placeholder="可选：例如 pg_default"
                    />
                </FieldContent>
            </Field>
        </div>
    );
}
