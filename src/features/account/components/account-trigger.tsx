import { useState, type FC } from "react";
import { CircleUserRoundIcon, ShieldAlertIcon } from "lucide-react";

import { BaseButton } from "@/components/ui/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuthSessionStore } from "@/store";

import { AccountCard, userInitials } from "./account-card";
import { AccountAvatar } from "./account-avatar";

interface AccountTriggerProps {
    onCloudSettingsRequested?: () => void;
}

const AccountTrigger: FC<AccountTriggerProps> = ({ onCloudSettingsRequested }) => {
    const [open, setOpen] = useState(false);
    const snapshot = useAuthSessionStore((state) => state.snapshot);
    const startSignIn = useAuthSessionStore((state) => state.startSignIn);
    const cancelSignIn = useAuthSessionStore((state) => state.cancelSignIn);
    const retrySession = useAuthSessionStore((state) => state.retrySession);
    const signOut = useAuthSessionStore((state) => state.signOut);
    const tooltip =
        snapshot.phase === "authenticated" && snapshot.user
            ? snapshot.user.displayName ?? snapshot.user.handle ?? "账号信息"
            : snapshot.phase === "restoring"
              ? "正在恢复 NIEEX Account 状态"
              : snapshot.phase === "reauthenticationRequired"
                ? "NIEEX Account 需要重新登录"
                : "登录 NIEEX Account（可选）";

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <PopoverTrigger
                        render={<BaseButton
                            variant="ghost"
                            size="icon"
                            aria-label={tooltip}
                        >
                            {snapshot.phase === "restoring" ? (
                                <Spinner />
                            ) : snapshot.phase === "authenticated" && snapshot.user ? (
                                <AccountAvatar
                                    user={snapshot.user}
                                    fallback={userInitials(snapshot.user)}
                                    size="sm"
                                />
                            ) : snapshot.phase === "reauthenticationRequired" ? (
                                <ShieldAlertIcon />
                            ) : (
                                <CircleUserRoundIcon />
                            )}
                        </BaseButton>}
                        />
                    }
                />
                <TooltipContent side="bottom">{tooltip}</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" sideOffset={8} className="w-80">
                <AccountCard
                    active={open}
                    snapshot={snapshot}
                    onStartSignIn={() => void startSignIn()}
                    onCancelSignIn={() => void cancelSignIn()}
                    onRetrySession={() => void retrySession()}
                    onSignOut={() => void signOut()}
                    onCloudSettingsRequested={
                        onCloudSettingsRequested
                            ? () => {
                                  setOpen(false);
                                  onCloudSettingsRequested();
                              }
                            : undefined
                    }
                />
            </PopoverContent>
        </Popover>
    );
};

export { AccountTrigger };
