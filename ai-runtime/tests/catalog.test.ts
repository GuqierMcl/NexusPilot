import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogService } from "../src/provider/catalog";
import { sampleModelsDevCatalog } from "../src/testing/fixtures";

let tempDirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "nexpilot-catalog-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("CatalogService", () => {
  test("loads catalog from local file before fetching remote", async () => {
    const dir = tempDir();
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify(sampleModelsDevCatalog));

    const service = new CatalogService({
      catalogPath,
      fetchCatalog: async () => {
        throw new Error("should not fetch");
      },
    });

    expect(await service.get()).toEqual(sampleModelsDevCatalog);
  });

  test("fetches remote and saves cache when file is missing", async () => {
    const dir = tempDir();
    const catalogPath = join(dir, "catalog.json");

    const service = new CatalogService({
      catalogPath,
      fetchCatalog: async () => sampleModelsDevCatalog,
    });

    expect(await service.get()).toEqual(sampleModelsDevCatalog);
    expect((await Bun.file(catalogPath).text()).length).toBeGreaterThan(0);
    const metadata = await Bun.file(join(dir, "catalog-metadata.json")).json();
    expect(metadata.version).toBe(1);
    expect(metadata.last_updated_at).toBeGreaterThan(0);
  });

  test("keeps the previous cache when a forced remote refresh fails", async () => {
    const dir = tempDir();
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify(sampleModelsDevCatalog));

    const service = new CatalogService({
      catalogPath,
      fetchCatalog: async () => null,
    });
    const result = await service.refresh(true);

    expect(result.status).toBe("using_cache");
    expect(result.catalog).toEqual(sampleModelsDevCatalog);
    expect(result.lastUpdatedAt).not.toBeNull();
  });

  test("reports an unavailable catalog when no cache and remote fetch are unavailable", async () => {
    const service = new CatalogService({
      catalogPath: join(tempDir(), "catalog.json"),
      fetchCatalog: async () => null,
    });

    expect(await service.refresh(true)).toEqual({
      catalog: {},
      status: "unavailable",
      lastUpdatedAt: null,
    });
  });

  test("returns empty catalog when file and remote are unavailable", async () => {
    const dir = tempDir();
    const service = new CatalogService({
      catalogPath: join(dir, "catalog.json"),
      fetchCatalog: async () => null,
    });

    expect(await service.get()).toEqual({});
  });
});
