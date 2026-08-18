import { useState, useEffect } from "react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { updateConnectionFolder } from "@/lib/tauri/connections";
import type { ExplorerTreeNode } from "@/features/workbench/explorer/types";
import { useExplorerStore } from "@/store";

interface RenameNodeDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    node: ExplorerTreeNode | null;
    onSuccess: () => void;
}

export function RenameNodeDialog({
    open,
    onOpenChange,
    node,
    onSuccess,
}: RenameNodeDialogProps) {
    const [renameName, setRenameName] = useState("");
    const [isRenaming, setIsRenaming] = useState(false);
    const folders = useExplorerStore((state) => state.folders);

    useEffect(() => {
        if (open && node) {
            setRenameName(node.label);
        } else if (!open) {
            setRenameName("");
        }
    }, [open, node]);

    async function handleConfirmRename() {
        if (!node) return;

        const name = renameName.trim();
        if (!name) {
            toast.error("名称不能为空");
            return;
        }

        if (node.type !== "group") {
            toast.error("目前仅支持重命名文件夹");
            return;
        }

        const folder = folders.find((f) => f.id === node.id);
        if (!folder) {
            toast.error("找不到文件夹信息");
            return;
        }

        setIsRenaming(true);
        try {
            await updateConnectionFolder({
                id: node.id,
                name,
                parentId: folder.parentId,
                sortOrder: folder.sortOrder,
            });
            toast.success("重命名成功");
            onOpenChange(false);
            onSuccess();
        } catch (error) {
            console.error("[explorer] rename failed", error);
            toast.error("重命名失败");
        } finally {
            setIsRenaming(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md" showCloseButton>
                <DialogHeader>
                    <DialogTitle>重命名</DialogTitle>
                </DialogHeader>
                <Field>
                    <FieldLabel htmlFor="rename-name">名称</FieldLabel>
                    <FieldContent>
                        <Input
                            id="rename-name"
                            autoComplete="off"
                            disabled={isRenaming}
                            value={renameName}
                            onChange={(e) => setRenameName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    void handleConfirmRename();
                                }
                            }}
                        />
                    </FieldContent>
                </Field>
                <div className="-mx-4 -mb-4 flex flex-row justify-end gap-2 rounded-b-xl border-t bg-muted/50 p-4">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={isRenaming}
                        onClick={() => onOpenChange(false)}
                    >
                        取消
                    </Button>
                    <Button
                        type="button"
                        disabled={isRenaming}
                        onClick={() => void handleConfirmRename()}
                    >
                        保存
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
