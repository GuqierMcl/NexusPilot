import { Copy } from "lucide-react";
import type { TableChangeSetPreview } from "@/types/ipc";
import { Button } from "@/components/ui/button";
import {
    Drawer,
    DrawerClose,
    DrawerContent,
    DrawerDescription,
    DrawerFooter,
    DrawerHeader,
    DrawerTitle,
} from "@/components/ui/drawer";

interface TableDataChangeDrawerProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    containerRef: HTMLDivElement | null;
    dmlPreview: TableChangeSetPreview | undefined;
    isInTransaction: boolean;
    onCopySql: (text: string) => void;
}

export function TableDataChangeDrawer({
    isOpen,
    onOpenChange,
    containerRef,
    dmlPreview,
    isInTransaction,
    onCopySql,
}: TableDataChangeDrawerProps) {
    return (
        <Drawer
            open={isOpen}
            onOpenChange={onOpenChange}
            container={containerRef}
            modal={false}
            handleOnly
        >
            <DrawerContent
                contained
                onPointerDownOutside={() => onOpenChange(false)}
            >
                <DrawerHeader>
                    <DrawerTitle>DML 预览</DrawerTitle>
                    <DrawerDescription>
                        即将提交 {dmlPreview?.summary.inserts ?? 0} 行新增、
                        {dmlPreview?.summary.updates ?? 0} 行更新、
                        {dmlPreview?.summary.deletes ?? 0} 行删除。
                        {isInTransaction
                            ? "当前保存会写入标签页事务，最终结果取决于后续提交或回滚。"
                            : "当前提交不启用事务，失败时不保证回滚已执行语句。"}
                    </DrawerDescription>
                </DrawerHeader>
                <div className="min-h-0 overflow-auto px-4 pb-2">
                    <div className="flex max-h-[48vh] select-text flex-col gap-2 overflow-auto rounded-md border bg-muted/30 p-3">
                        {dmlPreview?.statements.map((statement, index) => (
                            <pre
                                key={`${index}-${statement}`}
                                className="cursor-text select-text whitespace-pre-wrap wrap-break-word rounded-sm bg-background p-2 font-mono text-xs text-foreground"
                            >
                                {statement}
                            </pre>
                        ))}
                        {dmlPreview &&
                            dmlPreview.statements.length === 0 && (
                                <p className="text-sm text-muted-foreground">
                                    没有可预览的 DML。
                                </p>
                            )}
                    </div>
                </div>
                <DrawerFooter className="flex-row justify-end">
                    <Button
                        variant="outline"
                        disabled={
                            !dmlPreview ||
                            dmlPreview.statements.length === 0
                        }
                        onClick={() =>
                            onCopySql(
                                dmlPreview?.statements.join(";\n") ?? "",
                            )
                        }
                    >
                        <Copy data-icon="inline-start" />
                        复制 SQL
                    </Button>
                    <DrawerClose asChild>
                        <Button variant="secondary">关闭</Button>
                    </DrawerClose>
                </DrawerFooter>
            </DrawerContent>
        </Drawer>
    );
}
