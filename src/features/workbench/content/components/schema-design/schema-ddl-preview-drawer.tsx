import { CircleAlert, Copy, Download, TriangleAlert } from "lucide-react";

import {
    Alert,
    AlertDescription,
    AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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

export interface SchemaDdlPreviewDrawerProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    containerRef: HTMLDivElement | null;
    title: string;
    description: string;
    statements: string[];
    warnings: string[];
    validationMessages: string[];
    operations?: Array<{
        code: string;
        objectName: string;
        destructive: boolean;
        longRunning: boolean;
    }>;
    destructive?: boolean;
    longRunning?: boolean;
    isPending: boolean;
    errorMessage: string | null;
    onCopy: () => void;
    onExport: () => void;
}

export function joinSchemaDdlStatements(statements: readonly string[]): string {
    return statements.filter((statement) => statement.length > 0).join(";\n\n");
}

export function SchemaDdlPreviewDrawer({
    isOpen,
    onOpenChange,
    containerRef,
    title,
    description,
    statements,
    warnings,
    validationMessages,
    operations = [],
    destructive = false,
    longRunning = false,
    isPending,
    errorMessage,
    onCopy,
    onExport,
}: SchemaDdlPreviewDrawerProps) {
    const ddlText = joinSchemaDdlStatements(statements);
    const hasSql = ddlText.trim().length > 0;

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
                    <DrawerTitle>{title}</DrawerTitle>
                    <DrawerDescription>{description}</DrawerDescription>
                </DrawerHeader>
                <div className="min-h-0 overflow-auto px-4 pb-2">
                    <div className="flex max-h-[52vh] select-text flex-col gap-3 overflow-auto rounded-md border bg-muted/30 p-3">
                        {isPending && (
                            <p className="text-sm text-muted-foreground">
                                正在生成 DDL 预览...
                            </p>
                        )}
                        {errorMessage && (
                            <p className="text-sm text-destructive">
                                {errorMessage}
                            </p>
                        )}
                        {validationMessages.length > 0 && (
                            <Alert variant="destructive">
                                <CircleAlert />
                                <AlertTitle>当前草稿不可预览</AlertTitle>
                                <AlertDescription>
                                {validationMessages.map((message, index) => (
                                    <p key={`${message}-${index}`}>{message}</p>
                                ))}
                                </AlertDescription>
                            </Alert>
                        )}
                        {warnings.length > 0 && (
                            <Alert>
                                <TriangleAlert />
                                <AlertTitle>DDL 计划提示</AlertTitle>
                                <AlertDescription>
                                {warnings.map((warning, index) => (
                                    <p key={`${warning}-${index}`}>{warning}</p>
                                ))}
                                </AlertDescription>
                            </Alert>
                        )}
                        {operations.length > 0 && (
                            <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs font-medium">
                                        计划操作
                                    </span>
                                    {destructive && (
                                        <Badge variant="destructive">
                                            破坏性
                                        </Badge>
                                    )}
                                    {longRunning && (
                                        <Badge variant="secondary">
                                            可能耗时
                                        </Badge>
                                    )}
                                </div>
                                {operations.map((operation, index) => (
                                    <div
                                        key={`${operation.code}-${operation.objectName}-${index}`}
                                        className="flex flex-wrap items-center gap-2 text-xs"
                                    >
                                        <code className="font-mono">
                                            {operation.code}
                                        </code>
                                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                            {operation.objectName}
                                        </span>
                                        {operation.destructive && (
                                            <Badge variant="destructive">
                                                破坏性
                                            </Badge>
                                        )}
                                        {operation.longRunning && (
                                            <Badge variant="secondary">
                                                耗时
                                            </Badge>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                        {hasSql ? (
                            <pre className="cursor-text select-text whitespace-pre-wrap wrap-break-word rounded-sm bg-background p-3 font-mono text-xs text-foreground">
                                {ddlText}
                            </pre>
                        ) : (
                            !isPending && (
                                <p className="text-sm text-muted-foreground">
                                    没有可预览的 DDL。
                                </p>
                            )
                        )}
                    </div>
                </div>
                <DrawerFooter className="flex-row justify-end">
                    <Button variant="outline" disabled={!hasSql} onClick={onCopy}>
                        <Copy data-icon="inline-start" />
                        复制 SQL
                    </Button>
                    <Button variant="outline" disabled={!hasSql} onClick={onExport}>
                        <Download data-icon="inline-start" />
                        导出 .sql
                    </Button>
                    <DrawerClose asChild>
                        <Button variant="secondary">关闭</Button>
                    </DrawerClose>
                </DrawerFooter>
            </DrawerContent>
        </Drawer>
    );
}
