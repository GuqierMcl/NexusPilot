import { useEffect, useState } from "react";

import type { TableRowLocator } from "@/types/ipc";
import { Input } from "@/components/ui/input";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";

interface TableDataConfirmDialogsProps {
    tableName: string;
    pendingDeleteKeys: TableRowLocator[] | null;
    pendingRefreshDiscard: boolean;
    isSavePending: boolean;
    onPendingDeleteKeysChange: (pendingDeleteKeys: TableRowLocator[] | null) => void;
    onPendingRefreshDiscardChange: (pendingRefreshDiscard: boolean) => void;
    onConfirmDeleteRows: () => void;
    onConfirmRefreshDiscard: () => void;
}

export function TableDataConfirmDialogs({
    tableName,
    pendingDeleteKeys,
    pendingRefreshDiscard,
    isSavePending,
    onPendingDeleteKeysChange,
    onPendingRefreshDiscardChange,
    onConfirmDeleteRows,
    onConfirmRefreshDiscard,
}: TableDataConfirmDialogsProps) {
    const [deleteConfirmation, setDeleteConfirmation] = useState("");

    useEffect(() => {
        if (pendingDeleteKeys != null) {
            setDeleteConfirmation("");
        }
    }, [pendingDeleteKeys]);

    return (
        <>
            <AlertDialog
                open={pendingDeleteKeys != null}
                onOpenChange={(open) => {
                    if (!open && !isSavePending) {
                        onPendingDeleteKeysChange(null);
                    }
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>标记为待删除？</AlertDialogTitle>
                        <AlertDialogDescription>
                            将把「{tableName}」中的{" "}
                            {pendingDeleteKeys?.length ?? 0}{" "}
                            行标记为待删除。保存更改前不会写入数据库。为避免误操作，请输入表名确认。
                        </AlertDialogDescription>
                        <Input
                            value={deleteConfirmation}
                            placeholder={`输入 ${tableName}`}
                            aria-label="输入表名确认删除"
                            autoComplete="off"
                            disabled={isSavePending}
                            onChange={(event) =>
                                setDeleteConfirmation(event.target.value)
                            }
                        />
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isSavePending}>
                            取消
                        </AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={
                                isSavePending || deleteConfirmation !== tableName
                            }
                            onClick={(event) => {
                                event.preventDefault();
                                onConfirmDeleteRows();
                            }}
                        >
                            <Trash2 data-icon="inline-start" />
                            标记待删除
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog
                open={pendingRefreshDiscard}
                onOpenChange={onPendingRefreshDiscardChange}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            丢弃未保存修改并刷新？
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            当前表格存在未保存修改。刷新会丢弃这些修改并重新加载数据库中的数据。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            onClick={() => {
                                onPendingRefreshDiscardChange(false);
                                onConfirmRefreshDiscard();
                            }}
                        >
                            丢弃并刷新
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
