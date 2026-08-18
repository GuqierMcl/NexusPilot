import { useEffect, useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { DEFAULT_SETTINGS_SECTION, type SettingsSection } from "./settings-sections";
import { SettingsWorkspace } from "./components/settings-workspace";

interface SettingsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialSection?: SettingsSection;
}

export function SettingsDialog({
    open,
    onOpenChange,
    initialSection = DEFAULT_SETTINGS_SECTION,
}: SettingsDialogProps) {
    const [activeSection, setActiveSection] = useState<SettingsSection>(
        initialSection,
    );

    useEffect(() => {
        if (open) {
            setActiveSection(initialSection);
        }
    }, [initialSection, open]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="h-[80vh] sm:max-w-4xl sm:max-h-[60vh]"
                showCloseButton
            >
                <DialogTitle className="sr-only">设置</DialogTitle>
                <DialogDescription className="sr-only">
                    管理 NexusPilot Cloud、应用外观、编辑器、关于信息、AI 服务供应商和模型。
                </DialogDescription>
                <SettingsWorkspace
                    activeSection={activeSection}
                    onActiveSectionChange={setActiveSection}
                />
            </DialogContent>
        </Dialog>
    );
}
