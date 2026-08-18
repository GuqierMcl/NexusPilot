import { createHash } from "node:crypto";
import type { RuntimeDatabase } from "./runtime-database";

export interface RuntimeMigration {
  id: string;
  description: string;
  sql: string;
}

export interface RuntimeMigrationLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

export interface RuntimeMigrationManagerOptions {
  logger?: RuntimeMigrationLogger;
}

interface AppliedMigrationRow {
  id: string;
  checksum: string;
}

const MIGRATION_ID_PATTERN = /^\d{4}_[a-z0-9_]+$/;

export function runRuntimeMigrations(
  db: RuntimeDatabase,
  migrations: RuntimeMigration[],
  options: RuntimeMigrationManagerOptions = {},
): void {
  validateRuntimeMigrations(migrations);
  ensureMigrationTable(db);

  const applied = new Map(
    db
      .query<AppliedMigrationRow, []>(
        "SELECT id, checksum FROM runtime_schema_migrations ORDER BY id",
      )
      .all()
      .map((row) => [row.id, row.checksum] as const),
  );

  const insertMigration = db.query(
    `INSERT INTO runtime_schema_migrations (id, description, checksum, applied_at)
    VALUES (?, ?, ?, ?)`,
  );

  for (const migration of migrations) {
    const checksum = checksumRuntimeMigration(migration);
    const appliedChecksum = applied.get(migration.id);

    if (appliedChecksum !== undefined) {
      if (appliedChecksum !== checksum) {
        throw new Error(
          `Runtime migration checksum mismatch for ${migration.id}: expected ${appliedChecksum}, got ${checksum}`,
        );
      }
      continue;
    }

    const appliedAt = Date.now();

    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(
        migration.id,
        migration.description,
        checksum,
        appliedAt,
      );
    });

    applyMigration();
    applied.set(migration.id, checksum);
    options.logger?.info(
      {
        migrationId: migration.id,
        description: migration.description,
        checksum,
        appliedAt,
      },
      "runtime migration applied",
    );
  }
}

export function checksumRuntimeMigration(migration: RuntimeMigration): string {
  return createHash("sha256")
    .update(normalizeMigrationSql(migration.sql))
    .digest("hex");
}

function ensureMigrationTable(db: RuntimeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

function validateRuntimeMigrations(migrations: RuntimeMigration[]): void {
  const seen = new Set<string>();
  let previousId = "";

  for (const migration of migrations) {
    if (!MIGRATION_ID_PATTERN.test(migration.id)) {
      throw new Error(`Invalid runtime migration id: ${migration.id}`);
    }

    if (seen.has(migration.id)) {
      throw new Error(`Duplicate runtime migration id: ${migration.id}`);
    }

    if (previousId && migration.id <= previousId) {
      throw new Error("Runtime migrations must be sorted by id");
    }

    seen.add(migration.id);
    previousId = migration.id;
  }
}

function normalizeMigrationSql(sql: string): string {
  return sql.trim().replace(/\r\n/g, "\n");
}
