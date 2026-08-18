import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { useState } from "react";

import { toast } from "@/components/ui/toast";
import {
    Field,
    FieldContent,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import {
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupInput,
} from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import type { DriverConfigValueMap } from "@/features/workbench/explorer/driver-configs/types";

type Value = DriverConfigValueMap["sqlite"];

export type SqliteConnectionFormProps = {
    value: Value;
    onChange: (value: Value) => void;
    disabled?: boolean;
};

export function SqliteConnectionForm({
    value,
    onChange,
    disabled,
}: SqliteConnectionFormProps) {
    const [isSelectingFile, setIsSelectingFile] = useState(false);

    function patch(partial: Partial<Value>) {
        onChange({ ...value, ...partial });
    }

    async function selectDatabaseFile(): Promise<void> {
        if (disabled || isSelectingFile) return;

        setIsSelectingFile(true);
        try {
            const selectedPath = await open({
                title: "选择 SQLite 数据库文件",
                defaultPath: value.dbFilePath.trim() || undefined,
                multiple: false,
                directory: false,
                filters: [
                    {
                        name: "SQLite 数据库",
                        extensions: ["db", "sqlite", "sqlite3", "db3"],
                    },
                    { name: "所有文件", extensions: ["*"] },
                ],
            });

            if (selectedPath) {
                patch({ dbFilePath: selectedPath });
            }
        } catch (error) {
            console.error(
                "[SqliteConnectionForm] failed to select database file",
                error,
            );
            toast.error("选择数据库文件失败，可重试");
        } finally {
            setIsSelectingFile(false);
        }
    }

    return (
        <FieldGroup className="gap-4">
            <Field>
                <FieldLabel htmlFor="sqlite-db-file-path">数据库文件路径</FieldLabel>
                <FieldContent>
                    <InputGroup>
                        <InputGroupInput
                            id="sqlite-db-file-path"
                            autoComplete="off"
                            disabled={disabled || isSelectingFile}
                            value={value.dbFilePath}
                            onChange={(event) =>
                                patch({ dbFilePath: event.target.value })
                            }
                            placeholder="例如：D:/data/app.sqlite3"
                        />
                        <InputGroupAddon align="inline-end">
                            <InputGroupButton
                                disabled={disabled || isSelectingFile}
                                onClick={() => void selectDatabaseFile()}
                            >
                                <FolderOpen />
                                浏览
                            </InputGroupButton>
                        </InputGroupAddon>
                    </InputGroup>
                    <FieldDescription>
                        选择已有本地文件，或直接粘贴完整路径；不支持网络地址、SSH 或云端文件。
                    </FieldDescription>
                </FieldContent>
            </Field>

            <Field orientation="horizontal">
                <FieldContent>
                    <FieldLabel htmlFor="sqlite-read-only">只读模式</FieldLabel>
                    <FieldDescription>
                        默认以只读方式打开已有文件；关闭后会以可写连接打开该文件。
                    </FieldDescription>
                </FieldContent>
                <Switch
                    id="sqlite-read-only"
                    checked={value.isReadOnly ?? true}
                    disabled={disabled}
                    onCheckedChange={(checked) => patch({ isReadOnly: checked })}
                />
            </Field>
        </FieldGroup>
    );
}
