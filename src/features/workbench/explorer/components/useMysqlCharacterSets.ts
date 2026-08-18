import { useEffect, useState } from "react";

import type { ExplorerTreeNode } from "@/features/workbench/explorer/types";
import {
    getMysqlDatabaseCharacterSet,
    listMysqlCharacterSets,
} from "@/lib/tauri/schema-mutations";
import type { StoredDatabaseConnection } from "@/types";
import type { DatabaseCharacterSet } from "@/types/ipc";

export function useMysqlCharacterSets(
    open: boolean,
    connection: StoredDatabaseConnection | null,
) {
    const [characterSets, setCharacterSets] = useState<DatabaseCharacterSet[]>(
        [],
    );
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (!open || connection?.driver !== "mysql") {
            setCharacterSets([]);
            setIsLoading(false);
            return;
        }

        let canceled = false;
        setIsLoading(true);
        listMysqlCharacterSets(connection.id)
            .then((items) => {
                if (!canceled) {
                    setCharacterSets(items);
                }
            })
            .catch((error) => {
                if (!canceled) {
                    console.error("[explorer] load MySQL character sets failed", error);
                }
            })
            .finally(() => {
                if (!canceled) {
                    setIsLoading(false);
                }
            });

        return () => {
            canceled = true;
        };
    }, [connection?.driver, connection?.id, open]);

    return { characterSets, isLoading };
}

export function useMysqlDatabaseCharacterSet(
    open: boolean,
    connection: StoredDatabaseConnection | null,
    node: ExplorerTreeNode | null,
) {
    const [characterSet, setCharacterSet] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const container =
            node && "metadata" in node ? node.metadata.container : undefined;
        if (!open || connection?.driver !== "mysql" || !container) {
            setCharacterSet(null);
            setIsLoading(false);
            return;
        }

        let canceled = false;
        setIsLoading(true);
        getMysqlDatabaseCharacterSet(connection.id, container)
            .then((value) => {
                if (!canceled) {
                    setCharacterSet(value);
                }
            })
            .catch((error) => {
                if (!canceled) {
                    console.error(
                        "[explorer] load MySQL database character set failed",
                        error,
                    );
                    setCharacterSet(null);
                }
            })
            .finally(() => {
                if (!canceled) {
                    setIsLoading(false);
                }
            });

        return () => {
            canceled = true;
        };
    }, [connection?.driver, connection?.id, node?.id, open]);

    return { characterSet, isLoading };
}
