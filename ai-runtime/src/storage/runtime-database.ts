import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
  runRuntimeMigrations,
  type RuntimeMigrationManagerOptions,
} from "./runtime-migration-manager";
import { RUNTIME_MIGRATIONS } from "./runtime-migrations";

export type RuntimeDatabase = Database;
export type RuntimeDatabaseOptions = RuntimeMigrationManagerOptions;

export function openRuntimeDatabase(
  path: string,
  options: RuntimeDatabaseOptions = {},
): RuntimeDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON;");
  migrateRuntimeDatabase(db, options);
  return db;
}

export function migrateRuntimeDatabase(
  db: RuntimeDatabase,
  options: RuntimeDatabaseOptions = {},
): void {
  runRuntimeMigrations(db, RUNTIME_MIGRATIONS, options);
}
