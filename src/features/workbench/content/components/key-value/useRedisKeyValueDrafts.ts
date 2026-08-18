import {
    useCallback,
    type Dispatch,
    type SetStateAction,
} from "react";

import {
    useTabRuntimeStateStore,
    type KeyValueCreateDraft,
    type KeyValueEditableDraftValue,
    type KeyValueRuntimeState,
} from "@/store";

import {
    appendCollectionRow,
    createDefaultCreateDraft,
    createDefaultEditableValue,
    deleteCollectionRow,
    getCollectionLength,
    type EditableCollectionValue,
    CREATE_KEY_TYPE_OPTIONS,
} from "./redis-key-value-utils";

type PatchKeyValueState = ReturnType<
    typeof useTabRuntimeStateStore.getState
>["patchKeyValueState"];

interface UseRedisKeyValueDraftsOptions {
    tabId: string;
    patchKeyValueState: PatchKeyValueState;
    editableCollectionValue: EditableCollectionValue | null;
    selectedCollectionRowIndex: number | null;
    setSelectedCollectionRowIndex: Dispatch<SetStateAction<number | null>>;
    createCollectionValue: EditableCollectionValue | null;
    selectedCreateCollectionRowIndex: number | null;
    setSelectedCreateCollectionRowIndex: Dispatch<SetStateAction<number | null>>;
}

export function useRedisKeyValueDrafts({
    tabId,
    patchKeyValueState,
    editableCollectionValue,
    selectedCollectionRowIndex,
    setSelectedCollectionRowIndex,
    createCollectionValue,
    selectedCreateCollectionRowIndex,
    setSelectedCreateCollectionRowIndex,
}: UseRedisKeyValueDraftsOptions) {
    const updateValueDraft = useCallback(
        (patch: Partial<NonNullable<KeyValueRuntimeState["valueDraft"]>>) => {
            patchKeyValueState(tabId, (current) => ({
                valueDraft: current.valueDraft
                    ? { ...current.valueDraft, ...patch }
                    : current.valueDraft,
            }));
        },
        [patchKeyValueState, tabId],
    );

    const handleValueDraftChange = useCallback(
        (nextValueDraft: KeyValueEditableDraftValue) => {
            updateValueDraft({ valueDraft: nextValueDraft });
        },
        [updateValueDraft],
    );

    const handleAddCollectionRow = useCallback(() => {
        if (!editableCollectionValue) return;
        const nextValue = appendCollectionRow(editableCollectionValue);
        updateValueDraft({ valueDraft: nextValue });
        setSelectedCollectionRowIndex(getCollectionLength(nextValue) - 1);
    }, [editableCollectionValue, setSelectedCollectionRowIndex, updateValueDraft]);

    const handleDeleteCollectionRow = useCallback(() => {
        if (!editableCollectionValue || selectedCollectionRowIndex == null) return;
        updateValueDraft({
            valueDraft: deleteCollectionRow(
                editableCollectionValue,
                selectedCollectionRowIndex,
            ),
        });
        setSelectedCollectionRowIndex(null);
    }, [
        editableCollectionValue,
        selectedCollectionRowIndex,
        setSelectedCollectionRowIndex,
        updateValueDraft,
    ]);

    const handleKeyDraftChange = useCallback(
        (keyDraft: string) => {
            updateValueDraft({ keyDraft });
        },
        [updateValueDraft],
    );

    const updateCreateDraft = useCallback(
        (patch: Partial<KeyValueCreateDraft>) => {
            patchKeyValueState(tabId, (current) => ({
                createDraft: current.createDraft
                    ? { ...current.createDraft, ...patch }
                    : current.createDraft,
            }));
        },
        [patchKeyValueState, tabId],
    );

    const handleCreateKeyDraftChange = useCallback(
        (keyDraft: string) => {
            updateCreateDraft({ keyDraft });
        },
        [updateCreateDraft],
    );

    const handleCreateValueKindChange = useCallback(
        (kind: string) => {
            const option = CREATE_KEY_TYPE_OPTIONS.find(
                (item) => item.value === kind,
            );
            if (!option) return;

            patchKeyValueState(tabId, (current) => {
                const currentDraft =
                    current.createDraft ?? createDefaultCreateDraft(option.value);
                return {
                    createDraft: {
                        keyDraft: currentDraft.keyDraft,
                        valueKind: option.value,
                        valueDraft: createDefaultEditableValue(option.value),
                        ttlSecondsDraft: currentDraft.ttlSecondsDraft,
                    },
                };
            });
        },
        [patchKeyValueState, tabId],
    );

    const handleCreateTtlDraftChange = useCallback(
        (ttlSecondsDraft: string) => {
            updateCreateDraft({ ttlSecondsDraft });
        },
        [updateCreateDraft],
    );

    const handleCreateValueDraftChange = useCallback(
        (nextValueDraft: KeyValueEditableDraftValue) => {
            updateCreateDraft({
                valueKind: nextValueDraft.kind,
                valueDraft: nextValueDraft,
            });
        },
        [updateCreateDraft],
    );

    const handleAddCreateCollectionRow = useCallback(() => {
        if (!createCollectionValue) return;
        const nextValue = appendCollectionRow(createCollectionValue);
        updateCreateDraft({
            valueKind: nextValue.kind,
            valueDraft: nextValue,
        });
        setSelectedCreateCollectionRowIndex(getCollectionLength(nextValue) - 1);
    }, [
        createCollectionValue,
        setSelectedCreateCollectionRowIndex,
        updateCreateDraft,
    ]);

    const handleDeleteCreateCollectionRow = useCallback(() => {
        if (!createCollectionValue || selectedCreateCollectionRowIndex == null) {
            return;
        }
        updateCreateDraft({
            valueDraft: deleteCollectionRow(
                createCollectionValue,
                selectedCreateCollectionRowIndex,
            ),
        });
        setSelectedCreateCollectionRowIndex(null);
    }, [
        createCollectionValue,
        selectedCreateCollectionRowIndex,
        setSelectedCreateCollectionRowIndex,
        updateCreateDraft,
    ]);

    return {
        handleValueDraftChange,
        handleAddCollectionRow,
        handleDeleteCollectionRow,
        handleKeyDraftChange,
        handleCreateKeyDraftChange,
        handleCreateValueKindChange,
        handleCreateTtlDraftChange,
        handleCreateValueDraftChange,
        handleAddCreateCollectionRow,
        handleDeleteCreateCollectionRow,
    };
}
