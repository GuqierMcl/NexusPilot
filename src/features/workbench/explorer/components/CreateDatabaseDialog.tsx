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
import { useMysqlCharacterSets } from "@/features/workbench/explorer/components/useMysqlCharacterSets";
import { getDriverConfig } from "@/features/workbench/explorer/driver-configs";
import { submitCreateDatabaseWithFreshPreview } from "@/features/workbench/explorer/driver-configs/create-database-operations";
import type { DatabaseMutationContext } from "@/features/workbench/explorer/driver-configs/types";
import type { StoredDatabaseConnection } from "@/types";
import type { CreateDatabaseResult } from "@/types/ipc";

interface CreateDatabaseDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    connection: StoredDatabaseConnection | null;
    onSuccess: (result: CreateDatabaseResult) => void;
}

export function CreateDatabaseDialog({
    open,
    onOpenChange,
    connection,
    onSuccess,
}: CreateDatabaseDialogProps) {
    const driverConfig = useMemo(
        () => (connection ? getDriverConfig(connection.driver) : undefined),
        [connection],
    );
    const createDatabaseSpec = driverConfig?.createDatabase;
    const { characterSets, isLoading: isLoadingCharacterSets } =
        useMysqlCharacterSets(open, connection);
    const context = useMemo<DatabaseMutationContext | null>(() => {
        if (!connection || !driverConfig) return null;
        return {
            connectionDriver: driverConfig.driver,
            connectionId: connection.id,
            connectionName: connection.name,
            characterSets,
            isCharacterSetsLoading: isLoadingCharacterSets,
        };
    }, [characterSets, connection, driverConfig, isLoadingCharacterSets]);

    const [value, setValue] = useState<any>({});
    const [isCreating, setIsCreating] = useState(false);
    const [previewStatements, setPreviewStatements] = useState<string[]>([]);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    const previewRequestIdRef = useRef(0);
    const submitRequestIdRef = useRef(0);
    const valueRef = useRef<any>(value);
    valueRef.current = value;

    useEffect(() => {
        if (open && createDatabaseSpec && context) {
            setValue(createDatabaseSpec.createDefaultValue(context));
            setPreviewStatements([]);
        }
        submitRequestIdRef.current += 1;
        if (!open) {
            setValue({});
            setIsCreating(false);
            setPreviewStatements([]);
            setIsPreviewLoading(false);
        }
    }, [connection?.id, createDatabaseSpec, open]);

    useEffect(() => {
        if (!open || !connection || !createDatabaseSpec || !context) {
            previewRequestIdRef.current += 1;
            setPreviewStatements([]);
            setIsPreviewLoading(false);
            return;
        }

        const requestId = previewRequestIdRef.current + 1;
        previewRequestIdRef.current = requestId;
        const validationMessage = createDatabaseSpec.validate(value, context);
        if (validationMessage) {
            setPreviewStatements([]);
            setIsPreviewLoading(false);
            return;
        }

        let input: any;
        try {
            input = createDatabaseSpec.buildInput(value, context);
        } catch (error) {
            console.error("[explorer] build create database preview input failed", error);
            setPreviewStatements([]);
            setIsPreviewLoading(false);
            return;
        }

        setIsPreviewLoading(true);
        const timer = window.setTimeout(() => {
            createDatabaseSpec.operation
                .preview(connection.id, input)
                .then((preview: any) => {
                    if (previewRequestIdRef.current === requestId) {
                        setPreviewStatements(preview.statements);
                    }
                })
                .catch((error: unknown) => {
                    if (previewRequestIdRef.current === requestId) {
                        console.error(
                            "[explorer] preview create database failed",
                            error,
                        );
                        setPreviewStatements([]);
                    }
                })
                .finally(() => {
                    if (previewRequestIdRef.current === requestId) {
                        setIsPreviewLoading(false);
                    }
                });
        }, 250);
        return () => window.clearTimeout(timer);
    }, [connection, context, createDatabaseSpec, open, value]);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!connection || !createDatabaseSpec || !context) {
            toast.error("该连接类型暂不支持新增数据库");
            return;
        }

        const validationMessage = createDatabaseSpec.validate(value, context);
        if (validationMessage) {
            toast.error(validationMessage);
            return;
        }

        setIsCreating(true);
        try {
            const input = createDatabaseSpec.buildInput(value, context);
            const inputKey = JSON.stringify(input);
            const requestId = submitRequestIdRef.current + 1;
            submitRequestIdRef.current = requestId;
            const result = await submitCreateDatabaseWithFreshPreview(
                createDatabaseSpec.operation,
                connection.id,
                input,
                () => {
                    if (submitRequestIdRef.current !== requestId) return false;
                    try {
                        const latestInput = createDatabaseSpec.buildInput(
                            valueRef.current,
                            context,
                        );
                        return JSON.stringify(latestInput) === inputKey;
                    } catch (error) {
                        console.error(
                            "[explorer] rebuild create database input failed",
                            error,
                        );
                        return false;
                    }
                },
            );
            if (result === null) return;
            const resultName = createDatabaseSpec.operation.getResultName(result);
            toast.success(`数据库“${resultName}”已创建`);
            onOpenChange(false);
            onSuccess(result as CreateDatabaseResult);
        } catch (error) {
            console.error("[explorer] create database failed", error);
        } finally {
            setIsCreating(false);
        }
    }

    const isBusy = isCreating || isPreviewLoading;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[min(90vh,720px)] overflow-y-auto sm:max-w-lg" showCloseButton>
                <DialogHeader>
                    <DialogTitle>新增数据库</DialogTitle>
                    <DialogDescription>
                        {connection
                            ? `在连接“${connection.name}”中创建数据库。`
                            : "在当前连接中创建数据库。"}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={(event) => void handleSubmit(event)}>
                    <div className="flex flex-col gap-4">
                        {createDatabaseSpec && context
                            ? createDatabaseSpec.renderForm({
                                  value,
                                  onChange: setValue,
                                  disabled: isCreating,
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
