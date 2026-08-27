import { stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { workspaceExists, workspacePaths } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";
import { getJournalMode, openDatabase, verifyDatabase } from "../storage/database.js";
import { SCHEMA_VERSION } from "../version.js";
import { availableLanguageAdapters } from "../parser/registry.js";
import { availableFrameworkAdapters } from "../framework/registry.js";
import { getStatus } from "./status.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  severity?: "info" | "warning" | "error";
}

export async function runDoctor(startPath = process.cwd()): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const [major = 0] = process.versions.node
    .split(".")
    .slice(0, 1)
    .map((part) => Number.parseInt(part, 10));
  const supportedNode = major >= 24;
  checks.push({
    name: "Node.js",
    ok: supportedNode,
    detail: `${process.version}${supportedNode ? "" : " (Node.js 24 or newer is required)"}`,
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

  const frameworkAdapters = availableFrameworkAdapters();
  checks.push({
    name: "Framework adapters",
    ok: frameworkAdapters.length >= 4,
    detail: frameworkAdapters.map((adapter) => adapter.name).join(", "),
  });

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
        severity:
          healthy && journalMode === "wal" && schema.version === SCHEMA_VERSION
            ? "info"
            : "error",
      });

      const unsupported = database
        .prepare(
          `SELECT path FROM files
           WHERE parse_status IN ('unsupported', 'unsupported_parser')
           ORDER BY path LIMIT 100`,
        )
        .all() as Array<{ path: string }>;
      const unsupportedKinds = [...new Set(
        unsupported.map((row) => path.posix.extname(row.path).toLowerCase() || "extensionless"),
      )];
      checks.push({
        name: "Unsupported languages",
        ok: unsupported.length === 0,
        detail: unsupported.length === 0
          ? "none"
          : `${unsupported.length} files (${unsupportedKinds.join(", ")}) use generic file metadata only`,
        severity: unsupported.length === 0 ? "info" : "warning",
      });

      const unresolvedImports = database
        .prepare(
          `SELECT count(*) FROM resolution_issues
           WHERE reference_kind = 'import' AND reason = 'unresolved_reference'`,
        )
        .pluck()
        .get() as number;
      checks.push({
        name: "Unresolved imports",
        ok: unresolvedImports === 0,
        detail: unresolvedImports === 0 ? "none" : `${unresolvedImports} unresolved import references`,
        severity: unresolvedImports === 0 ? "info" : "warning",
      });

      const dynamicRelationships = database
        .prepare(
          `SELECT
             (SELECT count(*) FROM resolution_issues
               WHERE reason IN ('dynamic_relationship', 'generated_code')) +
             (SELECT count(*) FROM edges
               WHERE provenance_category = 'dynamic') AS count`,
        )
        .pluck()
        .get() as number;
      checks.push({
        name: "Dynamic relationships",
        ok: dynamicRelationships === 0,
        detail: dynamicRelationships === 0
          ? "none"
          : `${dynamicRelationships} candidate or unresolved dynamic relationships`,
        severity: dynamicRelationships === 0 ? "info" : "warning",
      });

      const indexingFailures = database
        .prepare(
          `SELECT count(*) FROM files
           WHERE parse_status IN ('parsed_with_errors', 'parse_error')`,
        )
        .pluck()
        .get() as number;
      checks.push({
        name: "Indexing failures",
        ok: indexingFailures === 0,
        detail: indexingFailures === 0 ? "none" : `${indexingFailures} files have parser failures`,
        severity: indexingFailures === 0 ? "info" : "warning",
      });

      const foreignKeyFailures = (database.pragma("foreign_key_check") as unknown[]).length;
      const invalidProvenance = database
        .prepare(
          `SELECT
             (SELECT count(*) FROM nodes WHERE provenance_category NOT IN
               ('verified', 'inferred', 'dynamic', 'documentation', 'git', 'unresolved')) +
             (SELECT count(*) FROM edges WHERE provenance_category NOT IN
               ('verified', 'inferred', 'dynamic', 'documentation', 'git', 'unresolved'))`,
        )
        .pluck()
        .get() as number;
      checks.push({
        name: "Graph integrity",
        ok: foreignKeyFailures === 0 && invalidProvenance === 0,
        detail: `foreign_key_failures=${foreignKeyFailures}, invalid_provenance=${invalidProvenance}`,
        severity: foreignKeyFailures === 0 && invalidProvenance === 0 ? "info" : "error",
      });

      const frameworkFailures = database
        .prepare(
          `SELECT count(*) FROM nodes
           WHERE kind = 'file'
             AND coalesce(json_extract(metadata_json, '$.frameworkAdapterFailureCount'), 0) > 0`,
        )
        .pluck()
        .get() as number;
      checks.push({
        name: "Framework coverage gaps",
        ok: frameworkFailures === 0,
        detail: frameworkFailures === 0
          ? `none across ${frameworkAdapters.length} registered adapters`
          : `${frameworkFailures} files fell back to generic AST analysis`,
        severity: frameworkFailures === 0 ? "info" : "warning",
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

  try {
    const status = await getStatus(repository.root);
    checks.push({
      name: "Stale files",
      ok: status.synchronized,
      detail: status.synchronized
        ? "none; HEAD, index, working tree, untracked files, deletions, and hashes match"
        : "the stored graph differs from the current Git or file-hash state; run `codeatlas index`",
      severity: status.synchronized ? "info" : "warning",
    });
  } catch (error) {
    checks.push({
      name: "Stale files",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      severity: "error",
    });
  }

  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  return checks
    .map((check) => `${check.ok ? "✓" : check.severity === "warning" ? "!" : "✗"} ${check.name}: ${check.detail}`)
    .join("\n");
}
