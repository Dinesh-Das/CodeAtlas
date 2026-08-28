import type { AtlasDatabase } from "./database.js";

export const GENERATION_STATE_KEYS = {
  structural: "structural_generation",
  semantic: "semantic_generation",
  search: "search_generation",
  architecture: "architecture_generation",
} as const;

export interface RepositoryGenerations {
  structural: number;
  semantic: number;
  search: number;
  architecture: number;
}

function generationValue(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

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

export function generationsFromState(
  state: Readonly<Record<string, string>>,
): RepositoryGenerations {
  return {
    structural: generationValue(state[GENERATION_STATE_KEYS.structural]),
    semantic: generationValue(state[GENERATION_STATE_KEYS.semantic]),
    search: generationValue(state[GENERATION_STATE_KEYS.search]),
    architecture: generationValue(state[GENERATION_STATE_KEYS.architecture]),
  };
}

export function getRepositoryGenerations(database: AtlasDatabase): RepositoryGenerations {
  return generationsFromState(getRepositoryStates(database));
}

export function nextStructuralGeneration(
  state: Readonly<Record<string, string>>,
): number {
  return generationsFromState(state).structural + 1;
}
