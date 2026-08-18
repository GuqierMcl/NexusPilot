export interface RawSqlArtifactOwner {
    profileId: string;
    tabId: string;
    executionId: string;
    artifactId: string;
}

export interface RawSqlResultSavePort {
    selectDestination(defaultPath: string): Promise<string | null>;
    save(
        input: RawSqlArtifactOwner & { destinationPath: string },
    ): Promise<void>;
}

export function buildRawResultDefaultFilename(
    format: string | null,
): string {
    const normalized = format?.trim().toUpperCase() ?? "";
    const extension = normalized.startsWith("CSV")
        ? "csv"
        : normalized.startsWith("TSV") ||
            normalized.startsWith("TABSEPARATED")
          ? "tsv"
          : normalized.startsWith("JSON")
            ? "json"
            : normalized.startsWith("XML")
              ? "xml"
              : normalized.startsWith("PARQUET")
                ? "parquet"
                : normalized.startsWith("ARROW")
                  ? "arrow"
                  : "bin";
    return `nexuspilot-result.${extension}`;
}

export async function saveRawSqlResult(
    port: RawSqlResultSavePort,
    input: RawSqlArtifactOwner & { format: string | null },
): Promise<"saved" | "canceled"> {
    const destinationPath = await port.selectDestination(
        buildRawResultDefaultFilename(input.format),
    );
    if (destinationPath == null) return "canceled";
    const { format: _format, ...owner } = input;
    await port.save({ ...owner, destinationPath });
    return "saved";
}
