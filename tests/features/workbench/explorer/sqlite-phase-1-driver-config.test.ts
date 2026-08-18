import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const readSource = (path: string) => readFileSync(path, "utf8");

describe("SQLite phase 1 local-file driver config", () => {
    test("enables SQLite in the desktop picker", () => {
        const source = readSource(
            "src/features/workbench/explorer/components/SelectDatabaseTypeDialog.tsx",
        );

        expect(source).toContain('displayName: "SQLite"');
        expect(source).toContain('driver: "sqlite", displayName: "SQLite"');
        expect(source).toContain('iconKey: "sqlite"');
        expect(source).toContain("isImplemented: true");
    });

    test("registers SQLite as a local-file driver only", () => {
        const typesSource = readSource(
            "src/features/workbench/explorer/driver-configs/types.ts",
        );
        const indexSource = readSource(
            "src/features/workbench/explorer/driver-configs/index.ts",
        );
        const configSource = readSource(
            "src/features/workbench/explorer/driver-configs/sqlite.tsx",
        );
        const formSource = readSource(
            "src/features/workbench/explorer/components/connection-forms/SqliteConnectionForm.tsx",
        );

        expect(typesSource).toContain("ISqlitePayload");
        expect(typesSource).toMatch(/sqlite:\s+Omit<ISqlitePayload,\s+"driver">;/);
        expect(indexSource).toContain("sqliteDriverConfig");
        expect(indexSource).toContain("sqlite: sqliteDriverConfig");
        expect(configSource).toContain('driver: "sqlite"');
        expect(configSource).toContain('connectionModel: "local-file"');
        expect(configSource).toContain("SqliteIcon");
        expect(configSource).toContain('dbFilePath: ""');
        expect(configSource).toContain("isReadOnly: true");
        expect(formSource).toContain('htmlFor="sqlite-db-file-path"');
        expect(formSource).toContain('id="sqlite-read-only"');
        expect(formSource).not.toContain("value.host");
        expect(formSource).not.toContain("value.port");
        expect(formSource).not.toContain("value.username");
        expect(formSource).not.toContain("value.password");
        expect(formSource).not.toContain('htmlFor="sqlite-host"');
        expect(formSource).not.toContain('htmlFor="sqlite-port"');
        expect(formSource).not.toContain('htmlFor="sqlite-username"');
        expect(formSource).not.toContain('htmlFor="sqlite-password"');
    });
});
