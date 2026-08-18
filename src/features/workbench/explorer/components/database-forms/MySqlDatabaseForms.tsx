import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { CreateDatabaseNameForm } from "@/features/workbench/explorer/components/CreateDatabaseNameForm";
import type {
    DatabaseMutationContext,
    MysqlCreateDatabaseFormValue,
    MysqlEditDatabaseFormValue,
} from "@/features/workbench/explorer/driver-configs/types";

const DEFAULT_CHARACTER_SET_VALUE = "__mysql_default_character_set__";

interface MysqlCharacterSetSelectProps {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    context: DatabaseMutationContext;
    includeDefaultOption?: boolean;
}

function MysqlCharacterSetSelect({
    value,
    onChange,
    disabled,
    context,
    includeDefaultOption = false,
}: MysqlCharacterSetSelectProps) {
    const characterSets = context.characterSets ?? [];
    const characterSetItems = [
        ...(includeDefaultOption
            ? [
                  {
                      value: DEFAULT_CHARACTER_SET_VALUE,
                      label: "使用服务器默认字符集",
                  },
              ]
            : []),
        ...characterSets.map((characterSet) => ({
            value: characterSet.name,
            label: `${characterSet.name} (${characterSet.defaultCollation})`,
        })),
    ];
    const loading = context.isCharacterSetsLoading === true;
    const selectValue =
        includeDefaultOption && !value
            ? DEFAULT_CHARACTER_SET_VALUE
            : value || undefined;

    return (
        <Field>
            <FieldLabel>字符集</FieldLabel>
            <FieldContent>
                <Select
                    value={selectValue}
                    items={characterSetItems}
                    disabled={disabled || loading}
                    onValueChange={(nextValue) => {
                        if (nextValue == null) return;
                        onChange(
                            nextValue === DEFAULT_CHARACTER_SET_VALUE
                                ? ""
                                : nextValue,
                        );
                    }}
                >
                    <SelectTrigger className="w-full">
                        <SelectValue
                            placeholder={loading ? "正在加载字符集..." : "选择字符集"}
                        />
                    </SelectTrigger>
                    <SelectContent>
                        {includeDefaultOption ? (
                            <SelectItem value={DEFAULT_CHARACTER_SET_VALUE}>
                                使用服务器默认字符集
                            </SelectItem>
                        ) : null}
                        {characterSets.map((characterSet) => (
                            <SelectItem
                                key={characterSet.name}
                                value={characterSet.name}
                            >
                                {characterSet.name} ({characterSet.defaultCollation})
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </FieldContent>
        </Field>
    );
}

interface CreateMysqlDatabaseFormProps {
    value: MysqlCreateDatabaseFormValue;
    onChange: (value: MysqlCreateDatabaseFormValue) => void;
    disabled?: boolean;
    context: DatabaseMutationContext;
}

export function CreateMysqlDatabaseForm({
    value,
    onChange,
    disabled,
    context,
}: CreateMysqlDatabaseFormProps) {
    return (
        <div className="flex flex-col gap-4">
            <CreateDatabaseNameForm
                value={value}
                disabled={disabled}
                onChange={(nextValue) => onChange({ ...value, ...nextValue })}
            />
            <MysqlCharacterSetSelect
                value={value.characterSet}
                disabled={disabled}
                context={context}
                includeDefaultOption
                onChange={(characterSet) =>
                    onChange({ ...value, characterSet })
                }
            />
        </div>
    );
}

interface EditMysqlDatabaseFormProps {
    value: MysqlEditDatabaseFormValue;
    onChange: (value: MysqlEditDatabaseFormValue) => void;
    disabled?: boolean;
    context: DatabaseMutationContext;
}

export function EditMysqlDatabaseForm({
    value,
    onChange,
    disabled,
    context,
}: EditMysqlDatabaseFormProps) {
    const databaseName =
        context.node && "metadata" in context.node
            ? context.node.metadata.container?.database ?? context.node.label
            : context.node?.label;

    return (
        <div className="flex flex-col gap-4">
            {databaseName ? (
                <p className="text-sm text-muted-foreground">
                    将修改数据库“{databaseName}”的新建对象默认字符集。
                </p>
            ) : null}
            <MysqlCharacterSetSelect
                value={value.characterSet}
                disabled={disabled}
                context={context}
                onChange={(characterSet) =>
                    onChange({ ...value, characterSet })
                }
            />
        </div>
    );
}
