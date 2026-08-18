import { create } from "zustand";

interface WorkbenchStatusOverlayState {
    executionOverviewTabIds: string[] | null;
    openExecutionOverview(tabIds: string[]): void;
    closeExecutionOverview(): void;
}

export const useWorkbenchStatusOverlayStore =
    create<WorkbenchStatusOverlayState>((set) => ({
        executionOverviewTabIds: null,
        openExecutionOverview: (tabIds) =>
            set({ executionOverviewTabIds: [...new Set(tabIds)] }),
        closeExecutionOverview: () =>
            set({ executionOverviewTabIds: null }),
    }));
