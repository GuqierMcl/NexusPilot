import type React from "react";
import { create } from "zustand";

export type ToolbarActionId = string;
export type ToolbarIcon = React.ElementType<{
    className?: string;
    "data-icon"?: string;
}>;

export interface ContentToolbarActionMenuItem {
    id: ToolbarActionId;
    icon?: ToolbarIcon;
    label: string;
    title: string;
    disabled?: boolean;
    onClick?: () => void;
}

export interface ContentToolbarAction {
    id: ToolbarActionId;
    icon: ToolbarIcon;
    label: string;
    title: string;
    variant?: "default" | "ghost";
    disabled?: boolean;
    pressed?: boolean;
    onClick?: () => void;
    menuItems?: ContentToolbarActionMenuItem[];
}

export interface ContentToolbarContext {
    icon: ToolbarIcon;
    label: string;
}

export interface ContentToolbarModel {
    actions: ContentToolbarAction[];
    context?: ContentToolbarContext | null;
    emptyText?: string;
}

interface ContentToolbarState {
    modelsByTabId: Record<string, ContentToolbarModel | undefined>;
    setToolbar: (tabId: string, model: ContentToolbarModel) => void;
    clearToolbar: (tabId: string) => void;
}

function toolbarActionsEqual(
    left: ContentToolbarAction[] | undefined,
    right: ContentToolbarAction[],
): boolean {
    if (!left || left.length !== right.length) return false;

    return left.every((action, index) => {
        const next = right[index];
        return (
            next != null &&
            action.id === next.id &&
            action.icon === next.icon &&
            action.label === next.label &&
            action.title === next.title &&
            action.variant === next.variant &&
            action.disabled === next.disabled &&
            action.pressed === next.pressed &&
            action.onClick === next.onClick &&
            toolbarActionMenuItemsEqual(action.menuItems, next.menuItems)
        );
    });
}

function toolbarActionMenuItemsEqual(
    left: ContentToolbarActionMenuItem[] | undefined,
    right: ContentToolbarActionMenuItem[] | undefined,
): boolean {
    if (left == null || right == null) return left == null && right == null;
    if (left.length !== right.length) return false;

    return left.every((item, index) => {
        const next = right[index];
        return (
            next != null &&
            item.id === next.id &&
            item.icon === next.icon &&
            item.label === next.label &&
            item.title === next.title &&
            item.disabled === next.disabled &&
            item.onClick === next.onClick
        );
    });
}

function toolbarContextsEqual(
    left: ContentToolbarContext | null | undefined,
    right: ContentToolbarContext | null | undefined,
): boolean {
    if (left == null || right == null) return left == null && right == null;
    return left.icon === right.icon && left.label === right.label;
}

function toolbarModelsEqual(
    left: ContentToolbarModel | undefined,
    right: ContentToolbarModel,
): boolean {
    if (!left) return false;
    return (
        toolbarActionsEqual(left.actions, right.actions) &&
        toolbarContextsEqual(left.context, right.context) &&
        left.emptyText === right.emptyText
    );
}

export const useContentToolbarStore = create<ContentToolbarState>((set) => ({
    modelsByTabId: {},

    setToolbar: (tabId, model) => {
        set((state) => {
            if (toolbarModelsEqual(state.modelsByTabId[tabId], model)) {
                return state;
            }

            return {
                modelsByTabId: {
                    ...state.modelsByTabId,
                    [tabId]: model,
                },
            };
        });
    },

    clearToolbar: (tabId) => {
        set((state) => {
            if (!(tabId in state.modelsByTabId)) return state;

            const next = { ...state.modelsByTabId };
            delete next[tabId];
            return { modelsByTabId: next };
        });
    },
}));
