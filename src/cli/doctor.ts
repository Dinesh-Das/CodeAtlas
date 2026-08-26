import { stat } from "node:fs/promises";
import { loadConfig } from "../core/config.js";
import { workspaceExists, workspacePaths } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";
import { getJournalMode, openDatabase, verifyDatabase } from "../storage/database.js";
import { SCHEMA_VERSION } from "../version.js";
import { availableLanguageAdapters } from "../parser/registry.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(startPath = process.cwd()): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .slice(0, 2)
    .map((part) => Number.parseInt(part, 10));
  const supportedNode = major > 22 || (major === 22 && minor >= 12);
  checks.push({
    name: "Node.js",
    ok: supportedNode,
    detail: `${process.version}${supportedNode ? "" : " (Node.js 22.12 or newer is required)"}`,
  });

  try {
    const adapters = availableLanguageAdapters();
    for (const adapter of adapters) {
      const parsed = adapter.parseFile({
        repositoryId: "doctor",
        repositoryRoot: ".",
        relativeFilePath: `doctor.${adapter.language}`,
        language: adapter.language,
        content: "",
        contentHash: "doctor",
      });
      if (parsed.nodes.length !== 1 || parsed.nodes[0]?.kind !== "module") {
        throw new Error(`${adapter.language} returned an invalid smoke-test graph.`);
      }
    }
    checks.push({
      name: "Tree-sitter parsers",
      ok: true,
      detail: adapters.map((adapter) => adapter.language).join(", "),
    });
  } catch (error) {
    checks.push({
      name: "Tree-sitter parsers",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  let repository;
  try {
    repository = await detectRepository(startPath);
    checks.push({ name: "Git repository", ok: true, detail: repository.root });
  } catch (error) {
    checks.push({
      name: "Git repository",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return checks;
  }

  const initialized = await workspaceExists(repository.root);
  checks.push({
    name: "Workspace",
    ok: initialized,
    detail: initialized ? workspacePaths(repository.root).directory : "Run `codeatlas init`.",
  });
  if (!initialized) return checks;

  try {
    await loadConfig(repository.root);
    checks.push({ name: "Configuration", ok: true, detail: "valid" });
  } catch (error) {
    checks.push({
      name: "Configuration",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const databasePath = workspacePaths(repository.root).database;
  try {
    const databaseExists = (await stat(databasePath)).isFile();
    if (!databaseExists) throw new Error("atlas.db is missing; run `codeatlas index --full`.");
    const database = openDatabase(databasePath, { readonly: true });
    try {
      const healthy = verifyDatabase(database);
      const journalMode = getJournalMode(database);
      const schema = database
        .prepare("SELECT max(version) AS version FROM schema_migrations")
        .get() as { version: number | null };
      checks.push({
        name: "SQLite",
        ok: healthy && journalMode === "wal" && schema.version === SCHEMA_VERSION,
        detail: `quick_check=${healthy ? "ok" : "failed"}, journal_mode=${journalMode}, schema=${schema.version ?? "none"}`,
      });
    } finally {
      database.close();
    }
  } catch (error) {
    checks.push({
      name: "SQLite",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  return checks
    .map((check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`)
    .join("\n");
}
