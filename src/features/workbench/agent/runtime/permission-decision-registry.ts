interface RegisteredPermissionDecision {
    permissionId: string;
    confirmationText?: string;
}

const decisionByApprovalId = new Map<string, RegisteredPermissionDecision>();

export function registerPermissionDecision(
    approvalId: string,
    decision: RegisteredPermissionDecision,
): void {
    decisionByApprovalId.set(approvalId, decision);
}

export function readPermissionDecision(
    approvalId: string,
): RegisteredPermissionDecision | null {
    return decisionByApprovalId.get(approvalId) ?? null;
}

export function clearPermissionDecision(approvalId: string): void {
    decisionByApprovalId.delete(approvalId);
}
