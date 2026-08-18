import { SchemaDdlPreviewDrawer } from "@/features/workbench/content/components/schema-design/schema-ddl-preview-drawer";

import type { TableDesignValidationIssue } from "./validation/table-design-validation";

interface TableDesignDdlDrawerProps {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    containerRef: HTMLDivElement | null;
    mode: "create" | "edit";
    tableName: string;
    ddlText: string;
    validationIssues: TableDesignValidationIssue[];
    destructiveWarnings: string[];
    updatePreviewWarnings: string[];
    isPreviewPending: boolean;
    previewErrorMessage: string | null;
    onCopyDdl: () => void;
    onExportDdl: () => void;
}

export function TableDesignDdlDrawer({
    isOpen,
    onOpenChange,
    containerRef,
    mode,
    tableName,
    ddlText,
    validationIssues,
    destructiveWarnings,
    updatePreviewWarnings,
    isPreviewPending,
    previewErrorMessage,
    onCopyDdl,
    onExportDdl,
}: TableDesignDdlDrawerProps) {
    const warnings = [
        ...validationIssues
            .filter((issue) => issue.severity === "warning")
            .map((issue) => issue.message),
        ...updatePreviewWarnings,
    ];
    return (
        <SchemaDdlPreviewDrawer
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            containerRef={containerRef}
            title="DDL 预览"
            description={`${mode === "create" ? "即将创建" : "即将修改"} ${tableName || "未命名表"} 的结构。`}
            statements={ddlText.trim().length > 0 ? [ddlText] : []}
            warnings={warnings}
            validationMessages={destructiveWarnings}
            isPending={isPreviewPending}
            errorMessage={previewErrorMessage}
            onCopy={onCopyDdl}
            onExport={onExportDdl}
        />
    );
}
