import type { SVGProps } from "react";
import { useTheme } from "next-themes";

import MysqlDarkIcon from "@/components/icons/database/generated/mysql-dark/mysql-dark";
import MysqlLightIcon from "@/components/icons/database/generated/mysql-light/mysql-light";

export function MysqlIcon(props: SVGProps<SVGSVGElement>) {
    const { resolvedTheme } = useTheme();
    const Icon = resolvedTheme === "dark" ? MysqlDarkIcon : MysqlLightIcon;

    return <Icon {...props} />;
}
