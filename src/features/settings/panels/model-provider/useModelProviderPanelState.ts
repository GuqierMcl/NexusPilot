import { useMemo, useState } from "react";

import type {
    ProviderDetail,
    ProviderSummary,
} from "@/lib/ai-runtime/providers";

import {
    buildCustomModels,
    createCustomModelDraft,
    customModelDraftsFromModels,
    type CustomModelDraft,
} from "./model-provider-utils";

export type ProviderConfigDialogMode = "connect" | "edit" | null;
export type CustomProviderDialogMode = "create" | "edit" | null;

export function useModelProviderPanelState() {
    const [selectedProvider, setSelectedProvider] =
        useState<ProviderSummary | null>(null);
    const [providerConfigDialogMode, setProviderConfigDialogMode] =
        useState<ProviderConfigDialogMode>(null);
    const [customDialogMode, setCustomDialogMode] =
        useState<CustomProviderDialogMode>(null);
    const [editingCustomProvider, setEditingCustomProvider] =
        useState<ProviderDetail | null>(null);
    const [apiKey, setApiKey] = useState("");
    const [apiBase, setApiBase] = useState("");
    const [customProviderId, setCustomProviderId] = useState("");
    const [customProviderName, setCustomProviderName] = useState("");
    const [customApiBase, setCustomApiBase] = useState("");
    const [customApiKey, setCustomApiKey] = useState("");
    const [customModelRows, setCustomModelRows] = useState<CustomModelDraft[]>(
        () => [createCustomModelDraft()],
    );

    const customModels = useMemo(
        () => buildCustomModels(customModelRows),
        [customModelRows],
    );

    const canSubmitConnection =
        selectedProvider !== null &&
        (selectedProvider.hasApiKey || apiKey.trim().length > 0);
    const canSubmitCustomProvider =
        customProviderId.trim().length > 0 &&
        customProviderName.trim().length > 0 &&
        customApiBase.trim().length > 0 &&
        (customDialogMode === "edit" || customApiKey.trim().length > 0) &&
        Object.keys(customModels).length > 0;
    const canDiscoverCustomModels =
        customApiBase.trim().length > 0 &&
        customApiKey.trim().length > 0;

    const resetCustomProviderForm = () => {
        setCustomDialogMode(null);
        setEditingCustomProvider(null);
        setCustomProviderId("");
        setCustomProviderName("");
        setCustomApiBase("");
        setCustomApiKey("");
        setCustomModelRows([createCustomModelDraft()]);
    };

    const resetProviderConfigForm = () => {
        setSelectedProvider(null);
        setProviderConfigDialogMode(null);
        setApiKey("");
        setApiBase("");
    };

    const handleProviderConfigDialogOpenChange = (open: boolean) => {
        if (!open) {
            resetProviderConfigForm();
        }
    };

    const handleCustomDialogOpenChange = (open: boolean) => {
        if (!open) {
            resetCustomProviderForm();
        }
    };

    const openConnectDialog = (provider: ProviderSummary) => {
        setSelectedProvider(provider);
        setProviderConfigDialogMode("connect");
        setApiKey("");
        setApiBase(provider.apiBase);
    };

    const openProviderDetailForEdit = (provider: ProviderDetail) => {
        if (provider.source === "custom") {
            setEditingCustomProvider(provider);
            setCustomDialogMode("edit");
            setCustomProviderId(provider.id);
            setCustomProviderName(provider.name);
            setCustomApiBase(provider.apiBase);
            setCustomApiKey(provider.apiKey ?? "");
            setCustomModelRows(customModelDraftsFromModels(provider.models));
            return;
        }

        setSelectedProvider(provider);
        setProviderConfigDialogMode("edit");
        setApiKey(provider.apiKey ?? "");
        setApiBase(provider.apiBase);
    };

    const openCreateCustomProviderDialog = () => {
        setEditingCustomProvider(null);
        setCustomProviderId("");
        setCustomProviderName("");
        setCustomApiBase("");
        setCustomApiKey("");
        setCustomModelRows([createCustomModelDraft()]);
        setCustomDialogMode("create");
    };

    const updateCustomModelRow = (
        key: string,
        field: "id" | "name",
        value: string,
    ) => {
        setCustomModelRows((rows) =>
            rows.map((row) =>
                row.key === key ? { ...row, [field]: value } : row,
            ),
        );
    };

    const removeCustomModelRow = (key: string) => {
        setCustomModelRows((rows) => {
            const nextRows = rows.filter((row) => row.key !== key);
            return nextRows.length > 0 ? nextRows : [createCustomModelDraft()];
        });
    };

    const addCustomModelRow = () => {
        setCustomModelRows((rows) => [
            ...rows,
            createCustomModelDraft(),
        ]);
    };

    const replaceCustomModelRows = (
        models: Array<Pick<CustomModelDraft, "id" | "name">>,
    ) => {
        setCustomModelRows(models.map((model) => createCustomModelDraft(model)));
    };

    return {
        selectedProvider,
        providerConfigDialogMode,
        customDialogMode,
        editingCustomProvider,
        apiKey,
        apiBase,
        customProviderId,
        customProviderName,
        customApiBase,
        customApiKey,
        customModelRows,
        customModels,
        canSubmitConnection,
        canSubmitCustomProvider,
        canDiscoverCustomModels,
        setApiKey,
        setApiBase,
        setCustomProviderId,
        setCustomProviderName,
        setCustomApiBase,
        setCustomApiKey,
        resetCustomProviderForm,
        resetProviderConfigForm,
        handleProviderConfigDialogOpenChange,
        handleCustomDialogOpenChange,
        openConnectDialog,
        openProviderDetailForEdit,
        openCreateCustomProviderDialog,
        updateCustomModelRow,
        removeCustomModelRow,
        addCustomModelRow,
        replaceCustomModelRows,
    };
}

export type ModelProviderPanelState = ReturnType<typeof useModelProviderPanelState>;
