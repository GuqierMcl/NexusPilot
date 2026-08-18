import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DatabaseSqlPreview } from "@/features/workbench/explorer/components/DatabaseSqlPreview";
import { getDriverConfig } from "@/features/workbench/explorer/driver-configs";
import {
    submitSchemaDropWithFreshPreview,
    type SchemaDropAppliedResult,
} from "@/features/workbench/explorer/driver-configs/schema-drop-operations";
import type { ExplorerTreeNode } from "@/features/workbench/explorer/types";
import { normalizeIpcError } from "@/lib/ipc-error";
import type { StoredDatabaseConnection } from "@/types";
import type { ContainerRef } from "@/types/ipc";

interface DeleteTableDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    connection: StoredDatabaseConnection | null;
    node: ExplorerTreeNode | null;
    onSuccess: (result: SchemaDropAppliedResult) => void;
    onRefresh?: (container: ContainerRef) => void;
}

function getTableContainer(node: ExplorerTreeNode | null) {
    if (node?.type === "table" && node.metadata.container) {
        return node.metadata.container;
    }
    throw new Error("未找到表节点");
}

export function DeleteTableDialog({
    open,
    onOpenChange,
    connection,
    node,
    onSuccess,
    onRefresh,
}: DeleteTableDialogProps) {
    const driverConfig = useMemo(
        () => (connection ? getDriverConfig(connection.driver) : undefined),
        [connection],
    );
    const dropOperation = driverConfig?.dropTable;
    const [isAcknowledged, setIsAcknowledged] = useState(false);
    const [isSecondConfirmOpen, setIsSecondConfirmOpen] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [previewStatements, setPreviewStatements] = useState<string[]>([]);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    const previewRequestIdRef = useRef(0);

    useEffect(() => {
        if (open && connection && node) {
            setIsAcknowledged(false);
            setIsSecondConfirmOpen(false);
            setPreviewStatements([]);
        }
        if (!open) {
            setIsAcknowledged(false);
            setIsSecondConfirmOpen(false);
            setIsDeleting(false);
            setPreviewStatements([]);
            setIsPreviewLoading(false);
        }
    }, [connection, node, open]);

    useEffect(() => {
        if (!isSecondConfirmOpen || !connection || !node || !dropOperation) {
            setPreviewStatements([]);
            return;
        }

        let target: ContainerRef;
        try {
            target = getTableContainer(node);
        } catch (error) {
            console.error("[explorer] build drop table preview input failed", error);
            setPreviewStatements([]);
            return;
        }

        const requestId = previewRequestIdRef.current + 1;
        previewRequestIdRef.current = requestId;
        setIsPreviewLoading(true);
        dropOperation.preview(connection.id, target)
            .then((preview) => {
                if (previewRequestIdRef.current === requestId) {
                    setPreviewStatements(preview.statements);
                }
            })
            .catch((error) => {
                if (previewRequestIdRef.current === requestId) {
                    console.error("[explorer] preview drop table failed", error);
                    setPreviewStatements([]);
                }
            })
            .finally(() => {
                if (previewRequestIdRef.current === requestId) {
                    setIsPreviewLoading(false);
                }
            });
    }, [connection, dropOperation, isSecondConfirmOpen, node]);

    async function handleFinalDelete() {
        if (!connection || !node || !dropOperation) {
            toast.error("未找到可删除的表");
            return;
        }

        setIsDeleting(true);
        const requestId = previewRequestIdRef.current + 1;
        previewRequestIdRef.current = requestId;
        const isCurrent = () => previewRequestIdRef.current === requestId;
        try {
            const target = getTableContainer(node);
            const applied = await submitSchemaDropWithFreshPreview(
                dropOperation,
                connection.id,
                target,
                isCurrent,
            );
            if (!isCurrent()) return;
            if (!applied) {
                toast.warning("删除结果尚未确认，已保留远端节点并刷新元数据");
                onRefresh?.(target);
                setPreviewStatements([]);
                setIsSecondConfirmOpen(false);
                setIsAcknowledged(false);
                return;
            }
            toast.success(`表“${applied.name}”已删除`);
            onOpenChange(false);
            onSuccess(applied);
        } catch (error) {
            console.error("[explorer] drop table failed", error);
            if (normalizeIpcError(error).code === "RESOURCE_CONFLICT") {
                toast.warning("远端结构已变化，请刷新后重新确认");
                previewRequestIdRef.current += 1;
                setPreviewStatements([]);
                setIsSecondConfirmOpen(false);
                setIsAcknowledged(false);
            }
        } finally {
            setIsDeleting(false);
        }
    }

    const tableName = node?.label ?? "表";
    const canProceed =
        isAcknowledged &&
        !isDeleting &&
        !isPreviewLoading &&
        previewStatements.length > 0 &&
        dropOperation != null;

    return (
        <>
            <Dialog
                open={open && !isSecondConfirmOpen}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen) {
                        onOpenChange(false);
                    }
                }}
            >
                <DialogContent className="sm:max-w-md" showCloseButton>
                    <DialogHeader>
                        <DialogTitle>删除表</DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-4">
                        <p className="text-sm text-destructive">
                            此操作会删除表“{tableName}”及其全部数据，无法恢复。
                        </p>
                        <label className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                            <input
                                type="checkbox"
                                className="mt-1 size-4 rounded border-input"
                                checked={isAcknowledged}
                                onChange={(event) =>
                                    setIsAcknowledged(event.target.checked)
                                }
                            />
                            <span>我明白此操作不可恢复</span>
                        </label>
                    </div>
                    <div className="-mx-4 -mb-4 mt-4 flex flex-row justify-end gap-2 rounded-b-xl border-t bg-muted/50 p-4">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={isDeleting}
                            onClick={() => onOpenChange(false)}
                        >
                            取消
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            disabled={!isAcknowledged || isDeleting}
                            onClick={() => setIsSecondConfirmOpen(true)}
                        >
                            继续删除
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            <AlertDialog
                open={open && isSecondConfirmOpen}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen) {
                        onOpenChange(false);
                    }
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>再次确认删除</AlertDialogTitle>
                        <AlertDialogDescription>
                            请确认将要执行的删除语句。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <DatabaseSqlPreview
                        statements={previewStatements}
                        emptyLabel={
                            isPreviewLoading ? "正在生成删除 SQL 预览..." : undefined
                        }
                    />
                    <AlertDialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={isDeleting}
                            onClick={() => setIsSecondConfirmOpen(false)}
                        >
                            返回
                        </Button>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={!canProceed}
                            onClick={(event) => {
                                event.preventDefault();
                                void handleFinalDelete();
                            }}
                            className="bg-destructive text-destructive-foreground"
                        >
                            {isDeleting ? "删除中..." : "确认删除"}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
