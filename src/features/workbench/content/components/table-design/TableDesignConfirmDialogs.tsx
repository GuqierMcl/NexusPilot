import { Alert, AlertDescription } from "@/components/ui/alert";
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

interface TableDesignConfirmDialogsProps {
    isDestructiveConfirmOpen: boolean;
    isRefreshConfirmOpen: boolean;
    destructiveWarnings: string[];
    isUpdatePending: boolean;
    isRefreshingTableSchema: boolean;
    onDestructiveConfirmOpenChange: (open: boolean) => void;
    onRefreshConfirmOpenChange: (open: boolean) => void;
    onConfirmDestructiveSave: () => void;
    onConfirmRefreshTableSchema: () => void;
}

export function TableDesignConfirmDialogs({
    isDestructiveConfirmOpen,
    isRefreshConfirmOpen,
    destructiveWarnings,
    isUpdatePending,
    isRefreshingTableSchema,
    onDestructiveConfirmOpenChange,
    onRefreshConfirmOpenChange,
    onConfirmDestructiveSave,
    onConfirmRefreshTableSchema,
}: TableDesignConfirmDialogsProps) {
    return (
        <>
            <AlertDialog
                open={isDestructiveConfirmOpen}
                onOpenChange={onDestructiveConfirmOpenChange}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>确认保存破坏性表结构变更？</AlertDialogTitle>
                        <AlertDialogDescription>
                            本次保存会删除已有列，并永久删除该列中的数据。执行前请确认 DDL 预览符合预期。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <Alert variant="destructive">
                        <AlertDescription>
                            {destructiveWarnings.length > 0
                                ? destructiveWarnings.join("；")
                                : "将执行破坏性 ALTER TABLE 操作。"}
                        </AlertDescription>
                    </Alert>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isUpdatePending}>
                            取消
                        </AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={isUpdatePending || isRefreshingTableSchema}
                            onClick={onConfirmDestructiveSave}
                        >
                            确认保存
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog
                open={isRefreshConfirmOpen}
                onOpenChange={onRefreshConfirmOpenChange}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>刷新并丢弃当前草稿？</AlertDialogTitle>
                        <AlertDialogDescription>
                            当前表设计有未保存修改。刷新会重新读取数据库中的真实表结构，并用远端结构覆盖当前草稿。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={isRefreshingTableSchema}>
                            取消
                        </AlertDialogCancel>
                        <AlertDialogAction
                            disabled={isRefreshingTableSchema}
                            onClick={onConfirmRefreshTableSchema}
                        >
                            刷新
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
