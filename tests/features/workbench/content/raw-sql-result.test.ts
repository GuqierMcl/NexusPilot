import { expect, test } from "bun:test";

import {
    buildRawResultDefaultFilename,
    saveRawSqlResult,
    type RawSqlArtifactOwner,
    type RawSqlResultSavePort,
} from "../../../../src/features/workbench/content/components/sql-editor/raw-sql-result";

test("Raw default filename is derived only from the format allowlist", () => {
    expect(buildRawResultDefaultFilename("CSVWithNames")).toBe(
        "nexuspilot-result.csv",
    );
    expect(buildRawResultDefaultFilename("TabSeparatedWithNames")).toBe(
        "nexuspilot-result.tsv",
    );
    expect(buildRawResultDefaultFilename("JSONEachRow")).toBe(
        "nexuspilot-result.json",
    );
    expect(buildRawResultDefaultFilename("XML")).toBe(
        "nexuspilot-result.xml",
    );
    expect(buildRawResultDefaultFilename("Parquet")).toBe(
        "nexuspilot-result.parquet",
    );
    expect(buildRawResultDefaultFilename("ArrowStream")).toBe(
        "nexuspilot-result.arrow",
    );
    expect(buildRawResultDefaultFilename(null)).toBe("nexuspilot-result.bin");
    expect(buildRawResultDefaultFilename("../../query-id.sql")).toBe(
        "nexuspilot-result.bin",
    );
});

test("Raw save cancellation does not call backend and success forwards opaque ownership", async () => {
    const owner: RawSqlArtifactOwner & { format: string | null } = {
        profileId: "profile-1",
        tabId: "runtime-tab-1",
        executionId: "execution-1",
        artifactId: "artifact-1",
        format: "CSV",
    };
    const canceledCalls: Array<RawSqlArtifactOwner & { destinationPath: string }> = [];
    const canceledPort: RawSqlResultSavePort = {
        selectDestination: async () => null,
        save: async (input) => {
            canceledCalls.push(input);
        },
    };

    expect(await saveRawSqlResult(canceledPort, owner)).toBe("canceled");
    expect(canceledCalls).toEqual([]);

    const saveCalls: Array<RawSqlArtifactOwner & { destinationPath: string }> = [];
    const successPort: RawSqlResultSavePort = {
        selectDestination: async (defaultPath) => {
            expect(defaultPath).toBe("nexuspilot-result.csv");
            return "D:\\exports\\result.csv";
        },
        save: async (input) => {
            saveCalls.push(input);
        },
    };

    expect(await saveRawSqlResult(successPort, owner)).toBe("saved");
    expect(saveCalls).toEqual([
        {
            profileId: "profile-1",
            tabId: "runtime-tab-1",
            executionId: "execution-1",
            artifactId: "artifact-1",
            destinationPath: "D:\\exports\\result.csv",
        },
    ]);
});
