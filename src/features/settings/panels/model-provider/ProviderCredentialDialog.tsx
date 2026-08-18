import { KeyRoundIcon } from "lucide-react";

import type { ProviderSummary } from "@/lib/ai-runtime/providers";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import {
    InputGroup,
    InputGroupInput,
} from "@/components/ui/input-group";
import { InputPassword } from "@/components/ui/input-password";

import type { ProviderConfigDialogMode } from "./useModelProviderPanelState";

interface ProviderCredentialDialogProps {
    selectedProvider: ProviderSummary | null;
    mode: ProviderConfigDialogMode;
    apiKey: string;
    apiBase: string;
    canSubmit: boolean;
    isPending: boolean;
    onOpenChange: (open: boolean) => void;
    onApiKeyChange: (value: string) => void;
    onApiBaseChange: (value: string) => void;
    onCancel: () => void;
    onSubmit: () => void;
}

export function ProviderCredentialDialog({
    selectedProvider,
    mode,
    apiKey,
    apiBase,
    canSubmit,
    isPending,
    onOpenChange,
    onApiKeyChange,
    onApiBaseChange,
    onCancel,
    onSubmit,
}: ProviderCredentialDialogProps) {
    return (
        <Dialog
            open={selectedProvider !== null && mode !== null}
            onOpenChange={onOpenChange}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {mode === "edit" ? "编辑" : "连接"}{" "}
                        {selectedProvider?.name ?? "提供商"}
                    </DialogTitle>
                    <DialogDescription>
                        API 密钥和 API Base 只会保存到 AI Runtime 的本地配置中。
                    </DialogDescription>
                </DialogHeader>

                <FieldGroup>
                    <Field>
                        <FieldLabel htmlFor="provider-api-key">
                            API 密钥
                        </FieldLabel>
                        <InputPassword
                            id="provider-api-key"
                            value={apiKey}
                            leadingIcon={<KeyRoundIcon />}
                            placeholder="输入 API 密钥"
                            onChange={(event) =>
                                onApiKeyChange(event.target.value)
                            }
                        />
                        <FieldDescription>
                            可以点击右侧按钮查看或隐藏明文。
                        </FieldDescription>
                    </Field>

                    <Field>
                        <FieldLabel htmlFor="provider-api-base">
                            API Base
                        </FieldLabel>
                        <InputGroup>
                            <InputGroupInput
                                id="provider-api-base"
                                value={apiBase}
                                placeholder="使用默认地址"
                                onChange={(event) =>
                                    onApiBaseChange(event.target.value)
                                }
                            />
                        </InputGroup>
                    </Field>
                </FieldGroup>

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={onCancel}
                    >
                        取消
                    </Button>
                    <Button
                        disabled={!canSubmit || isPending}
                        onClick={onSubmit}
                    >
                        {mode === "edit" ? "保存" : "连接"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
