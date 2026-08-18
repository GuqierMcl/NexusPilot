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
import { Spinner } from "@/components/ui/spinner";
import type { KeyValuePendingDeleteTarget } from "@/store";

interface KeyValueConfirmDialogsProps {
    pendingDiscardOpen: boolean;
    deleteTargetForConfirm: KeyValuePendingDeleteTarget | null;
    isDeletePending: boolean;
    onDiscardDialogOpenChange: (open: boolean) => void;
    onConfirmDiscard: () => void;
    onDeleteDialogOpenChange: (open: boolean) => void;
    onConfirmDelete: () => Promise<void>;
}

export function KeyValueConfirmDialogs({
    pendingDiscardOpen,
    deleteTargetForConfirm,
    isDeletePending,
    onDiscardDialogOpenChange,
    onConfirmDiscard,
    onDeleteDialogOpenChange,
    onConfirmDelete,
}: KeyValueConfirmDialogsProps) {
    return (
        <>
            <AlertDialog
                open={pendingDiscardOpen}
                onOpenChange={onDiscardDialogOpenChange}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>丢弃未保存修改？</AlertDialogTitle>
                        <AlertDialogDescription>
                            当前 Redis key/value 存在未保存修改。继续操作会丢弃这些修改并重新加载远端数据。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            onClick={onConfirmDiscard}
                        >
                            丢弃并继续
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog
                open={deleteTargetForConfirm != null}
                onOpenChange={onDeleteDialogOpenChange}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {deleteTargetForConfirm?.kind === "prefix"
                                ? "删除目录下所有后代 key？"
                                : "删除这个 key？"}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {deleteTargetForConfirm?.kind === "prefix" ? (
                                <>
                                    这会删除前缀{" "}
                                    <span className="font-mono">
                                        {deleteTargetForConfirm.pattern}
                                    </span>{" "}
                                    下的所有 key，共{" "}
                                    {deleteTargetForConfirm.keyCount} 个。
                                </>
                            ) : (
                                <>
                                    这会永久删除 key{" "}
                                    <span className="font-mono">
                                        {deleteTargetForConfirm?.key}
                                    </span>
                                    ，无法恢复。
                                </>
                            )}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isDeletePending}>
                            取消
                        </AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={isDeletePending}
                            onClick={(event) => {
                                event.preventDefault();
                                void onConfirmDelete();
                            }}
                        >
                            {isDeletePending ? (
                                <Spinner data-icon="inline-start" />
                            ) : null}
                            删除
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
