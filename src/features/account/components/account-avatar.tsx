import type { FC } from "react";

import {
    Avatar,
    AvatarFallback,
    AvatarImage,
} from "@/components/ui/avatar";
import { useAuthAvatar } from "@/features/account/use-auth-avatar";
import type { AuthUser } from "@/types/ipc";

interface AccountAvatarProps {
    user: AuthUser;
    fallback: string;
    size: "default" | "sm" | "lg";
}

const AccountAvatar: FC<AccountAvatarProps> = ({ user, fallback, size }) => {
    const source = useAuthAvatar(user);

    return (
        <Avatar size={size}>
            {source ? <AvatarImage src={source} alt="" /> : null}
            <AvatarFallback>{fallback}</AvatarFallback>
        </Avatar>
    );
};

export { AccountAvatar };
