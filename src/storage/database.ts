import BetterSqlite3 from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { runMigrations } from "./migrations.js";

export type AtlasDatabase = BetterSqlite3.Database;

export function openDatabase(databasePath: string, options: { readonly?: boolean } = {}): AtlasDatabase {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new BetterSqlite3(databasePath, {
    readonly: options.readonly ?? false,
    fileMustExist: options.readonly ?? false,
  });
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");

    if (!(options.readonly ?? false)) {
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = NORMAL");
      runMigrations(database);
    }
  } catch (error) {
    database.close();
    throw error;
  }

  return database;
}

export async function removeDatabaseFiles(databasePath: string): Promise<void> {
  if (path.basename(databasePath) !== "atlas.db") {
    throw new Error("Refusing to remove an unexpected database path.");
  }
  await Promise.all(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((filePath) =>
      rm(filePath, { force: true }),
    ),
  );
}

export function getJournalMode(database: AtlasDatabase): string {
  const row = database.pragma("journal_mode", { simple: true });
  return String(row).toLowerCase();
}

export function verifyDatabase(database: AtlasDatabase): boolean {
  const result = database.pragma("quick_check", { simple: true });
  return result === "ok";
}
