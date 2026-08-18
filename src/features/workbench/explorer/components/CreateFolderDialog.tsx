import { useState, useEffect } from "react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { createConnectionFolder } from "@/lib/tauri/connections";

interface CreateFolderDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    targetFolderId: string | null;
    onSuccess: () => void;
}

export function CreateFolderDialog({
    open,
    onOpenChange,
    targetFolderId,
    onSuccess,
}: CreateFolderDialogProps) {
    const [newFolderName, setNewFolderName] = useState("");
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);

    useEffect(() => {
        if (!open) {
            setNewFolderName("");
        }
    }, [open]);

    async function handleConfirmCreateFolder() {
        const name = newFolderName.trim();
        if (!name) {
            toast.error("请填写文件夹名称");
            return;
        }

        setIsCreatingFolder(true);
        try {
            await createConnectionFolder({
                id: crypto.randomUUID(),
                name,
                parentId: targetFolderId,
                sortOrder: null,
            });
            toast.success("文件夹已创建");
            onOpenChange(false);
            onSuccess();
        } catch (error) {
            console.error("[explorer] create folder failed", error);
            toast.error(
                error instanceof Error ? error.message : "创建文件夹失败",
            );
        } finally {
            setIsCreatingFolder(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md" showCloseButton>
                <DialogHeader>
                    <DialogTitle>新建文件夹</DialogTitle>
                    <DialogDescription>
                        {targetFolderId
                            ? "在当前文件夹下创建子文件夹，用于整理连接。"
                            : "在连接列表根目录下创建文件夹，用于整理连接。"}
                    </DialogDescription>
                </DialogHeader>
                <Field>
                    <FieldLabel htmlFor="new-folder-name">文件夹名称</FieldLabel>
                    <FieldContent>
                        <Input
                            id="new-folder-name"
                            autoComplete="off"
                            disabled={isCreatingFolder}
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            placeholder="例如：生产环境"
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    void handleConfirmCreateFolder();
                                }
                            }}
                        />
                    </FieldContent>
                </Field>
                <div className="-mx-4 -mb-4 flex flex-row justify-end gap-2 rounded-b-xl border-t bg-muted/50 p-4">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={isCreatingFolder}
                        onClick={() => onOpenChange(false)}
                    >
                        取消
                    </Button>
                    <Button
                        type="button"
                        disabled={isCreatingFolder}
                        onClick={() => void handleConfirmCreateFolder()}
                    >
                        确定
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
