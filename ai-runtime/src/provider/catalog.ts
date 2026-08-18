import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const CACHE_TTL_SECONDS = 3600;
export const FETCH_TIMEOUT_MS = 10_000;

export type RawCatalog = Record<string, unknown>;
export type CatalogRefreshStatus = "updated" | "using_cache" | "unavailable";

export interface CatalogStatus {
  lastUpdatedAt: number | null;
}

export interface CatalogRefreshResult extends CatalogStatus {
  catalog: RawCatalog;
  status: CatalogRefreshStatus;
}

export interface CatalogServiceOptions {
  catalogPath: string;
  fetchCatalog?: () => Promise<RawCatalog | null>;
}

interface PersistedCatalogMetadata {
  version: 1;
  last_updated_at: number;
}

export class CatalogService {
  private memoryCache: RawCatalog | null = null;
  private lastUpdatedAt: number | null = null;
  private metadataLoaded = false;
  private readonly catalogPath: string;
  private readonly metadataPath: string;
  private readonly fetchCatalog: () => Promise<RawCatalog | null>;

  constructor(options: CatalogServiceOptions) {
    this.catalogPath = options.catalogPath;
    this.metadataPath = options.catalogPath
      ? join(dirname(options.catalogPath), "catalog-metadata.json")
      : "";
    this.fetchCatalog = options.fetchCatalog ?? fetchModelsDevCatalog;
  }

  async get(): Promise<RawCatalog> {
    if (this.memoryCache !== null) {
      return this.memoryCache;
    }

    const fromFile = await this.readCacheFile();
    if (fromFile !== null) {
      this.memoryCache = fromFile;
      await this.loadMetadata();
      return fromFile;
    }

    const fetched = await this.fetchCatalog();
    if (fetched !== null) {
      await this.persistFetchedCatalog(fetched);
      return fetched;
    }

    this.memoryCache = {};
    this.lastUpdatedAt = null;
    this.metadataLoaded = true;
    return {};
  }

  async refresh(force = false): Promise<CatalogRefreshResult> {
    if (!force && !this.isCacheStale()) {
      const catalog = await this.get();
      const { lastUpdatedAt } = await this.getStatus();
      return {
        catalog,
        status: "using_cache",
        lastUpdatedAt,
      };
    }

    const fetched = await this.fetchCatalog();
    if (fetched !== null) {
      await this.persistFetchedCatalog(fetched);
      return {
        catalog: fetched,
        status: "updated",
        lastUpdatedAt: this.lastUpdatedAt,
      };
    }

    this.memoryCache = null;
    const fromFile = await this.readCacheFile();
    if (fromFile !== null) {
      this.memoryCache = fromFile;
      await this.loadMetadata();
      return {
        catalog: fromFile,
        status: "using_cache",
        lastUpdatedAt: this.lastUpdatedAt,
      };
    }

    this.memoryCache = {};
    this.lastUpdatedAt = null;
    this.metadataLoaded = true;
    return {
      catalog: {},
      status: "unavailable",
      lastUpdatedAt: null,
    };
  }

  async getStatus(): Promise<CatalogStatus> {
    await this.loadMetadata();
    return { lastUpdatedAt: this.lastUpdatedAt };
  }

  isCacheStale(): boolean {
    if (!this.catalogPath) {
      return false;
    }

    try {
      const mtimeMs = statSync(this.catalogPath).mtimeMs;
      return Date.now() - mtimeMs >= CACHE_TTL_SECONDS * 1000;
    } catch {
      return false;
    }
  }

  reset(): void {
    this.memoryCache = null;
  }

  private async persistFetchedCatalog(catalog: RawCatalog): Promise<void> {
    const lastUpdatedAt = Date.now();
    this.memoryCache = catalog;
    this.lastUpdatedAt = lastUpdatedAt;
    this.metadataLoaded = true;
    await this.writeCacheFile(catalog);
    await this.writeMetadata(lastUpdatedAt);
  }

  private async readCacheFile(): Promise<RawCatalog | null> {
    if (!this.catalogPath) {
      return null;
    }

    try {
      const file = Bun.file(this.catalogPath);
      if (!(await file.exists())) {
        return null;
      }
      const parsed = await file.json();
      return isRawCatalog(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeCacheFile(data: RawCatalog): Promise<void> {
    if (!this.catalogPath) {
      return;
    }

    mkdirSync(dirname(this.catalogPath), { recursive: true });
    await Bun.write(this.catalogPath, `${JSON.stringify(data, null, 2)}\n`);
  }

  private async loadMetadata(): Promise<void> {
    if (this.metadataLoaded) {
      return;
    }

    this.metadataLoaded = true;
    const metadata = await this.readMetadata();
    if (metadata !== null) {
      this.lastUpdatedAt = metadata.last_updated_at;
      return;
    }

    const legacyMtime = this.readCacheMtime();
    this.lastUpdatedAt = legacyMtime;
    if (legacyMtime !== null) {
      await this.writeMetadata(legacyMtime);
    }
  }

  private async readMetadata(): Promise<PersistedCatalogMetadata | null> {
    if (!this.metadataPath) {
      return null;
    }

    try {
      const file = Bun.file(this.metadataPath);
      if (!(await file.exists())) {
        return null;
      }
      const parsed = await file.json();
      if (!isRecord(parsed) || parsed.version !== 1) {
        return null;
      }
      if (typeof parsed.last_updated_at !== "number" || parsed.last_updated_at <= 0) {
        return null;
      }
      return {
        version: 1,
        last_updated_at: parsed.last_updated_at,
      };
    } catch {
      return null;
    }
  }

  private async writeMetadata(lastUpdatedAt: number): Promise<void> {
    if (!this.metadataPath) {
      return;
    }

    mkdirSync(dirname(this.metadataPath), { recursive: true });
    const metadata: PersistedCatalogMetadata = {
      version: 1,
      last_updated_at: lastUpdatedAt,
    };
    await Bun.write(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  }

  private readCacheMtime(): number | null {
    if (!this.catalogPath) {
      return null;
    }

    try {
      return statSync(this.catalogPath).mtimeMs;
    } catch {
      return null;
    }
  }
}

export async function fetchModelsDevCatalog(): Promise<RawCatalog | null> {
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const parsed = await response.json();
    return isRawCatalog(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRawCatalog(value: unknown): value is RawCatalog {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
