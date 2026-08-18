import { useState } from "react";
import { toast } from "@/components/ui/toast";
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
import { deleteConnection, deleteConnectionFolder } from "@/lib/tauri/connections";
import type { ExplorerTreeNode } from "@/features/workbench/explorer/types";

interface DeleteNodeDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    node: ExplorerTreeNode | null;
    onSuccess: () => void;
}

export function DeleteNodeDialog({
    open,
    onOpenChange,
    node,
    onSuccess,
}: DeleteNodeDialogProps) {
    const [isDeleting, setIsDeleting] = useState(false);

    async function handleConfirmDelete() {
        if (!node) return;

        setIsDeleting(true);
        try {
            if (node.type === "group") {
                await deleteConnectionFolder(node.id);
            } else if (node.type === "connection") {
                await deleteConnection(node.id);
            }
            toast.success("删除成功");
            onOpenChange(false);
            onSuccess();
        } catch (error) {
            console.error("[explorer] delete failed", error);
            toast.error("删除失败");
        } finally {
            setIsDeleting(false);
        }
    }

    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>确认删除</AlertDialogTitle>
                    <AlertDialogDescription>
                        确定要删除 “{node?.label}” 吗？此操作无法撤销。
                        {node?.type === "group" &&
                            " 如果文件夹不为空，其中的连接也会被删除。"}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={isDeleting}>
                        取消
                    </AlertDialogCancel>
                    <AlertDialogAction
                        variant="destructive"
                        disabled={isDeleting}
                        onClick={(e) => {
                            e.preventDefault();
                            void handleConfirmDelete();
                        }}
                        className="bg-destructive text-destructive-foreground"
                    >
                        {isDeleting ? "删除中..." : "确认删除"}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
