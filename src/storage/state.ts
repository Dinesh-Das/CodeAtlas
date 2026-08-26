import type { AtlasDatabase } from "./database.js";

export function setRepositoryState(database: AtlasDatabase, key: string, value: string): void {
  database
    .prepare(
      `INSERT INTO repository_state(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function setRepositoryStates(
  database: AtlasDatabase,
  values: Readonly<Record<string, string>>,
): void {
  const statement = database.prepare(
    `INSERT INTO repository_state(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const [key, value] of Object.entries(values)) statement.run(key, value);
}

export function getRepositoryState(database: AtlasDatabase, key: string): string | null {
  const row = database.prepare("SELECT value FROM repository_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function getRepositoryStates(database: AtlasDatabase): Record<string, string> {
  const rows = database.prepare("SELECT key, value FROM repository_state ORDER BY key").all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
