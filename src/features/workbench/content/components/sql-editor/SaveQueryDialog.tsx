import { useEffect, useState, type FC } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface SaveQueryDialogProps {
    open: boolean;
    defaultTitle: string;
    isSaving: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (title: string) => void;
}

export const SaveQueryDialog: FC<SaveQueryDialogProps> = ({
    open,
    defaultTitle,
    isSaving,
    onOpenChange,
    onSave,
}) => {
    const [title, setTitle] = useState(defaultTitle);
    const trimmedTitle = title.trim();

    useEffect(() => {
        if (open) setTitle(defaultTitle);
    }, [defaultTitle, open]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>保存查询</DialogTitle>
                    <DialogDescription>
                        输入查询名称后保存到当前连接的查询列表。
                    </DialogDescription>
                </DialogHeader>
                <Input
                    value={title}
                    autoFocus
                    onChange={(event) => setTitle(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && trimmedTitle && !isSaving) {
                            onSave(trimmedTitle);
                        }
                    }}
                />
                <DialogFooter>
                    <Button
                        variant="outline"
                        disabled={isSaving}
                        onClick={() => onOpenChange(false)}
                    >
                        取消
                    </Button>
                    <Button
                        disabled={!trimmedTitle || isSaving}
                        onClick={() => onSave(trimmedTitle)}
                    >
                        保存
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
