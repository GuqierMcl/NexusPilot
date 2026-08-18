import type {
    ExplorerNodeActionContributor,
    ExplorerNodeActionContext,
    ExplorerNodeActionGroup,
} from "@/features/workbench/explorer/actions/types";

export type CollectedExplorerNodeActionContributions = {
    groups: ExplorerNodeActionGroup[];
    primaryActionId?: string;
};

export function collectExplorerNodeActionContributions(
    ctx: ExplorerNodeActionContext,
    contributors: ExplorerNodeActionContributor[],
): CollectedExplorerNodeActionContributions {
    const groups: ExplorerNodeActionGroup[] = [];
    let primaryActionId: string | undefined;

    for (const contributor of contributors) {
        const contribution = contributor(ctx);
        if (!contribution) continue;

        const visibleActions = contribution.actions.filter(
            (action) => action.visible !== false,
        );
        if (visibleActions.length === 0) continue;

        const existingGroup = groups.find(
            (group) => group.id === contribution.groupId,
        );

        if (existingGroup) {
            existingGroup.label = existingGroup.label ?? contribution.label;
            existingGroup.actions.push(...visibleActions);
        } else {
            groups.push({
                id: contribution.groupId,
                label: contribution.label,
                actions: visibleActions,
            });
        }

        primaryActionId = primaryActionId ?? contribution.primaryActionId;
    }

    return { groups, primaryActionId };
}
