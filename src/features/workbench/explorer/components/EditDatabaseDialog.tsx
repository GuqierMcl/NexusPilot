import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { DatabaseSqlPreview } from "@/features/workbench/explorer/components/DatabaseSqlPreview";
import {
    useMysqlCharacterSets,
    useMysqlDatabaseCharacterSet,
} from "@/features/workbench/explorer/components/useMysqlCharacterSets";
import { getDriverConfig } from "@/features/workbench/explorer/driver-configs";
import type { DatabaseMutationContext } from "@/features/workbench/explorer/driver-configs/types";
import type { ExplorerTreeNode } from "@/features/workbench/explorer/types";
import {
    previewUpdateDatabase,
    updateDatabase,
} from "@/lib/tauri/schema-mutations";
import type { StoredDatabaseConnection } from "@/types";
import type { UpdateDatabaseInput, UpdateDatabaseResult } from "@/types/ipc";

interface EditDatabaseDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    connection: StoredDatabaseConnection | null;
    node: ExplorerTreeNode | null;
    onSuccess: (result: UpdateDatabaseResult) => void;
}

export function EditDatabaseDialog({
    open,
    onOpenChange,
    connection,
    node,
    onSuccess,
}: EditDatabaseDialogProps) {
    const driverConfig = useMemo(
        () => (connection ? getDriverConfig(connection.driver) : undefined),
        [connection],
    );
    const editDatabaseSpec = driverConfig?.editDatabase;
    const { characterSets, isLoading: isLoadingCharacterSets } =
        useMysqlCharacterSets(open, connection);
    const {
        characterSet: currentDatabaseCharacterSet,
        isLoading: isLoadingCurrentDatabaseCharacterSet,
    } = useMysqlDatabaseCharacterSet(open, connection, node);
    const context = useMemo<DatabaseMutationContext | null>(() => {
        if (!connection || !driverConfig) return null;
        return {
            connectionDriver: driverConfig.driver,
            connectionId: connection.id,
            connectionName: connection.name,
            node,
            characterSets,
            isCharacterSetsLoading: isLoadingCharacterSets,
            currentDatabaseCharacterSet,
            isCurrentDatabaseCharacterSetLoading: isLoadingCurrentDatabaseCharacterSet,
        };
    }, [
        characterSets,
        connection,
        currentDatabaseCharacterSet,
        driverConfig,
        isLoadingCharacterSets,
        isLoadingCurrentDatabaseCharacterSet,
        node,
    ]);

    const [value, setValue] = useState<any>({});
    const [isSaving, setIsSaving] = useState(false);
    const [previewStatements, setPreviewStatements] = useState<string[]>([]);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    const previewRequestIdRef = useRef(0);

    useEffect(() => {
        if (open && editDatabaseSpec && context) {
            setValue(editDatabaseSpec.createDefaultValue(context));
            setPreviewStatements([]);
        }
        if (!open) {
            setValue({});
            setIsSaving(false);
            setPreviewStatements([]);
            setIsPreviewLoading(false);
        }
    }, [
        connection?.id,
        currentDatabaseCharacterSet,
        editDatabaseSpec,
        node?.id,
        open,
    ]);

    useEffect(() => {
        if (!open || !connection || !editDatabaseSpec || !context) {
            setPreviewStatements([]);
            return;
        }

        const validationMessage = editDatabaseSpec.validate(value, context);
        if (validationMessage) {
            setPreviewStatements([]);
            return;
        }

        let input: UpdateDatabaseInput;
        try {
            input = editDatabaseSpec.buildInput(value, context);
        } catch (error) {
            console.error("[explorer] build edit database preview input failed", error);
            setPreviewStatements([]);
            return;
        }

        const requestId = previewRequestIdRef.current + 1;
        previewRequestIdRef.current = requestId;
        setIsPreviewLoading(true);
        previewUpdateDatabase(connection.id, input)
            .then((preview) => {
                if (previewRequestIdRef.current === requestId) {
                    setPreviewStatements(preview.statements);
                }
            })
            .catch((error) => {
                if (previewRequestIdRef.current === requestId) {
                    console.error("[explorer] preview edit database failed", error);
                    setPreviewStatements([]);
                }
            })
            .finally(() => {
                if (previewRequestIdRef.current === requestId) {
                    setIsPreviewLoading(false);
                }
            });
    }, [connection, context, editDatabaseSpec, open, value]);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!connection || !editDatabaseSpec || !context) {
            toast.error("该连接类型暂不支持编辑数据库");
            return;
        }

        const validationMessage = editDatabaseSpec.validate(value, context);
        if (validationMessage) {
            toast.error(validationMessage);
            return;
        }

        setIsSaving(true);
        try {
            const input = editDatabaseSpec.buildInput(
                value,
                context,
            ) as UpdateDatabaseInput;
            const result = await updateDatabase(connection.id, input);
            toast.success(`数据库“${result.name}”已更新`);
            onOpenChange(false);
            onSuccess(result);
        } catch (error) {
            console.error("[explorer] update database failed", error);
        } finally {
            setIsSaving(false);
        }
    }

    const databaseName = node?.label ?? "数据库";
    const isBusy = isSaving || isPreviewLoading;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[min(90vh,760px)] overflow-y-auto sm:max-w-lg" showCloseButton>
                <DialogHeader>
                    <DialogTitle>编辑数据库</DialogTitle>
                    <DialogDescription>
                        编辑“{databaseName}”的结构属性，提交前请确认 SQL 预览。
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={(event) => void handleSubmit(event)}>
                    <div className="flex flex-col gap-4">
                        {editDatabaseSpec && context
                            ? editDatabaseSpec.renderForm({
                                  value,
                                  onChange: setValue,
                                  disabled: isSaving,
                                  context,
                              })
                            : null}
                        <DatabaseSqlPreview
                            statements={previewStatements}
                            emptyLabel={
                                isPreviewLoading
                                    ? "正在生成 SQL 预览..."
                                    : undefined
                            }
                        />
                    </div>
                    <div className="-mx-4 -mb-4 mt-4 flex flex-row justify-end gap-2 rounded-b-xl border-t bg-muted/50 p-4">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() => onOpenChange(false)}
                        >
                            取消
                        </Button>
                        <Button type="submit" disabled={isBusy}>
                            确定
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
