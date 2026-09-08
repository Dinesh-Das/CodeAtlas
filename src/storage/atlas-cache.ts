import type { Atlas } from "../ir/models.js";
import { symbolSearchText } from "../analysis/simplification.js";
import { openDatabase, type AtlasDatabase } from "./database.js";
import type { RepositoryGenerations } from "./state.js";

const ARRAY_SECTIONS = [
  "symbols",
  "relationships",
  "evidence",
  "resolution_issues",
  "domains",
  "entrypoint_ids",
  "flows",
  "control_flows",
  "git_changes",
  "rules",
  "rule_violations",
  "review_findings",
] as const;

type ArraySection = (typeof ARRAY_SECTIONS)[number];

export interface AtlasRuntimeManifest {
  runtime_kind: "query" | "full";
  current_fingerprint: string;
  generations: RepositoryGenerations;
  v2_config_fingerprint: string;
  git_available: boolean;
  git_base: string | null;
  git_head: string | null;
  schema_version: Atlas["schema_version"];
  generator: Atlas["generator"];
  project: Atlas["project"];
  snapshot: Atlas["snapshot"];
  statistics: Atlas["statistics"];
  section_counts: Record<ArraySection | "impact", number>;
}

function itemId(section: ArraySection, item: unknown, ordinal: number): string {
  if (section === "entrypoint_ids" && typeof item === "string") return item;
  if (typeof item === "object" && item !== null && "id" in item &&
    typeof (item as { id?: unknown }).id === "string") return (item as { id: string }).id;
  return `${section}:${ordinal}`;
}

export function persistAtlasRuntime(
  databasePath: string,
  atlas: Atlas,
  options: {
    kind?: "query" | "full";
    currentFingerprint: string;
    generations: RepositoryGenerations;
    configFingerprint: string;
    gitAvailable: boolean;
    gitBase: string | null;
    gitHead: string | null;
  },
): void {
  const database = openDatabase(databasePath);
  try {
    const now = new Date().toISOString();
    const manifest: AtlasRuntimeManifest = {
      runtime_kind: options.kind ?? "full",
      current_fingerprint: options.currentFingerprint,
      generations: options.generations,
      v2_config_fingerprint: options.configFingerprint,
      git_available: options.gitAvailable,
      git_base: options.gitBase,
      git_head: options.gitHead,
      schema_version: atlas.schema_version,
      generator: atlas.generator,
      project: atlas.project,
      snapshot: atlas.snapshot,
      statistics: atlas.statistics,
      section_counts: {
        ...Object.fromEntries(ARRAY_SECTIONS.map((section) => [section, atlas[section].length])),
        impact: 1,
      } as AtlasRuntimeManifest["section_counts"],
    };
    const replaceMetadata = database.prepare(
      `INSERT INTO atlas_metadata(id, payload_json, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
    );
    const insertSection = database.prepare(
      `INSERT INTO atlas_sections(section, ordinal, item_id, payload_json) VALUES (?, ?, ?, ?)`,
    );
    const insertSearch = database.prepare(
      "INSERT INTO atlas_symbol_search(id, text) VALUES (?, ?)",
    );
    database.transaction(() => {
      database.exec("DELETE FROM atlas_sections; DELETE FROM atlas_symbol_search;");
      replaceMetadata.run(JSON.stringify(manifest), now);
      for (const section of ARRAY_SECTIONS) {
        for (const [ordinal, item] of atlas[section].entries()) {
          const persisted = section === "evidence" && typeof item === "object" && item !== null
            ? { ...item, excerpt: null, excerpt_status: "unavailable" }
            : item;
          insertSection.run(section, ordinal, itemId(section, item, ordinal), JSON.stringify(persisted));
        }
      }
      insertSection.run("impact", 0, "impact", JSON.stringify(atlas.impact));
      for (const symbol of atlas.symbols) {
        insertSearch.run(symbol.id, symbolSearchText(symbol, atlas));
      }
    })();
  } finally {
    database.close();
  }
}

export function readAtlasRuntimeManifest(databasePath: string): AtlasRuntimeManifest | null {
  const database = openDatabase(databasePath, { readonly: true });
  try {
    const row = database.prepare("SELECT payload_json FROM atlas_metadata WHERE id = 1").get() as
      | { payload_json: string }
      | undefined;
    return row === undefined ? null : JSON.parse(row.payload_json) as AtlasRuntimeManifest;
  } finally {
    database.close();
  }
}

function readSection<T>(database: AtlasDatabase, section: string): T[] {
  const rows = database.prepare(
    "SELECT payload_json FROM atlas_sections WHERE section = ? ORDER BY ordinal",
  ).all(section) as Array<{ payload_json: string }>;
  return rows.map((row) => JSON.parse(row.payload_json) as T);
}

export function readAtlasRuntime(databasePath: string): Atlas | null {
  const database = openDatabase(databasePath, { readonly: true });
  try {
    const metadata = database.prepare("SELECT payload_json FROM atlas_metadata WHERE id = 1").get() as
      | { payload_json: string }
      | undefined;
    if (metadata === undefined) return null;
    const manifest = JSON.parse(metadata.payload_json) as AtlasRuntimeManifest;
    const sections = Object.fromEntries(ARRAY_SECTIONS.map((section) =>
      [section, readSection(database, section)]
    )) as unknown as Pick<Atlas, ArraySection>;
    const impact = readSection<Atlas["impact"]>(database, "impact")[0];
    if (impact === undefined) return null;
    return {
      schema_version: manifest.schema_version,
      generator: manifest.generator,
      project: manifest.project,
      snapshot: manifest.snapshot,
      statistics: manifest.statistics,
      ...sections,
      impact,
    };
  } finally {
    database.close();
  }
}
