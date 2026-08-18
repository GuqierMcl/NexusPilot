import type { ToolPermissionSnapshot } from "@/lib/ai-runtime/runs";

export function canApprovePermission(
    permission: ToolPermissionSnapshot | null,
    confirmationText: string,
): boolean {
    if (!permission || permission.status !== "pending") {
        return false;
    }
    if (permission.confirmation.level === "standard") {
        return true;
    }
    return (
        typeof permission.confirmation.prompt === "string" &&
        confirmationText === permission.confirmation.prompt
    );
}
