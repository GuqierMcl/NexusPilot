import type { ReactNode } from "react";

import type {
    SqlExecutionFeatures,
    SqlExecutionSnapshot,
} from "@/types/ipc";

import { clickhouseExecutionDetailContributor } from "./clickhouse-execution-detail-contributor";

export interface SqlExecutionDetailContext {
    uiTabId: string;
    profileId: string;
    driverName: string;
    features?: SqlExecutionFeatures;
    snapshot: SqlExecutionSnapshot;
}

export interface SqlExecutionDetailContributor {
    id: string;
    supports(context: SqlExecutionDetailContext): boolean;
    render(context: SqlExecutionDetailContext): ReactNode;
}

export interface SqlExecutionDetailContributorRegistry {
    register(contributor: SqlExecutionDetailContributor): () => void;
    resolve(
        context: SqlExecutionDetailContext,
    ): SqlExecutionDetailContributor[];
}

export function createSqlExecutionDetailContributorRegistry(): SqlExecutionDetailContributorRegistry {
    const contributors: SqlExecutionDetailContributor[] = [];

    return {
        register: (contributor) => {
            if (contributors.some((item) => item.id === contributor.id)) {
                throw new Error(
                    `SQL execution detail contributor '${contributor.id}' is already registered`,
                );
            }
            contributors.push(contributor);
            return () => {
                const index = contributors.indexOf(contributor);
                if (index >= 0) contributors.splice(index, 1);
            };
        },
        resolve: (context) =>
            contributors.filter((contributor) =>
                contributor.supports(context),
            ),
    };
}

export const sqlExecutionDetailContributorRegistry =
    createSqlExecutionDetailContributorRegistry();

sqlExecutionDetailContributorRegistry.register(
    clickhouseExecutionDetailContributor,
);
