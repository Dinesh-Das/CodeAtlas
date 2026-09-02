import { stat } from "node:fs/promises";
import path from "node:path";
import {
  classifyArchitecturalScope,
  isPrimaryArchitectureScope,
} from "../analysis/scope.js";
import { DEFAULT_CONFIG, loadConfig } from "../core/config.js";
import { workspaceExists, workspacePaths } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";
import { getJournalMode, openDatabase, verifyDatabase } from "../storage/database.js";
import { SCHEMA_VERSION } from "../version.js";
import { availableLanguageAdapters } from "../parser/registry.js";
import { availableFrameworkAdapters } from "../framework/registry.js";
import { semanticCompilerInfo } from "../graph/typescript-resolution.js";
import { getStatus } from "./status.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  severity?: "info" | "warning" | "error";
}

interface SemanticFailureSample {
  operation: string;
  file: string;
  message: string;
}

function semanticFailureSamples(value: string | undefined): SemanticFailureSample[] {
  if (value === undefined) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is SemanticFailureSample => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Record<string, unknown>;
      return typeof record.operation === "string" &&
        typeof record.file === "string" &&
        typeof record.message === "string";
    });
  } catch {
    return [];
  }
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

  const frameworkAdapters = availableFrameworkAdapters();
  checks.push({
    name: "Framework adapters",
    ok: frameworkAdapters.length >= 4,
    detail: frameworkAdapters.map((adapter) => adapter.name).join(", "),
  });

  let repository;
  try {
    repository = await detectRepository(startPath);
    checks.push({ name: "Repository root", ok: true, detail: repository.root });
    checks.push({
      name: "Git integration",
      ok: true,
      detail: repository.gitAvailable
        ? `${repository.branch} @ ${repository.headCommit}`
        : "unavailable; filesystem indexing mode is active and Git-only diff/history features are disabled",
      severity: "info",
    });
  } catch (error) {
    checks.push({
      name: "Repository root",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return checks;
  }


  const compiler = semanticCompilerInfo(repository.root);
  const compilerFallbackWarning = [
    "incompatible_version",
    "load_failed",
  ].includes(compiler.fallbackReason ?? "");
  const compilerDetail = compiler.source === "repository"
    ? `TypeScript ${compiler.version} from the target repository`
    : compiler.fallbackReason === "incompatible_api"
      ? `TypeScript ${compiler.version} bundled semantic compiler active (target TypeScript ${compiler.targetVersion} does not expose the required compiler API)`
      : compiler.fallbackReason === "incompatible_version"
        ? `TypeScript ${compiler.version} bundled fallback (target TypeScript ${compiler.targetVersion} is unsupported)`
        : compiler.fallbackReason === "load_failed"
          ? `TypeScript ${compiler.version} bundled fallback (target repository TypeScript could not be loaded)`
          : `TypeScript ${compiler.version} bundled fallback (target repository has no local TypeScript)`;
  checks.push({
    name: "Semantic compiler",
    ok: !compilerFallbackWarning,
    detail: compilerDetail,
    severity: compilerFallbackWarning ? "warning" : "info",
  });

  const initialized = await workspaceExists(repository.root);
  checks.push({
    name: "Workspace",
    ok: initialized,
    detail: initialized ? workspacePaths(repository.root).directory : "Run `codeatlas init`.",
  });
  if (!initialized) return checks;

  let config = DEFAULT_CONFIG;
  try {
    config = await loadConfig(repository.root);
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
      const compatibleSchema = schema.version === SCHEMA_VERSION;
      checks.push({
        name: "SQLite",
        ok: healthy && journalMode === "wal" && compatibleSchema,
        detail:
          `quick_check=${healthy ? "ok" : "failed"}, journal_mode=${journalMode}, ` +
          `schema=${schema.version ?? "none"}` +
          (compatibleSchema ? "" : `; expected ${SCHEMA_VERSION}, run \`codeatlas index --full\``),
        severity:
          healthy && journalMode === "wal" && compatibleSchema
            ? "info"
            : "error",
      });
      // Later diagnostics query columns and tables introduced by newer migrations. Stop with one
      // actionable compatibility error instead of obscuring it with a secondary SQL failure.
      if (!compatibleSchema) return checks;

      const semanticStateRows = database
        .prepare(
          `SELECT key, value FROM repository_state
           WHERE key IN (
             'semantic_resolution_failures',
             'semantic_public_api_failures',
             'semantic_failure_samples',
             'semantic_primary_failure_file_count'
           )`,
        )
        .all() as Array<{ key: string; value: string }>;
      const semanticState = Object.fromEntries(
        semanticStateRows.map((row) => [row.key, row.value]),
      );
      const callFailures = Number.parseInt(semanticState.semantic_resolution_failures ?? "0", 10) || 0;
      const publicApiFailures = Number.parseInt(
        semanticState.semantic_public_api_failures ?? "0",
        10,
      ) || 0;
      const semanticFailures = callFailures + publicApiFailures;
      const failureSamples = semanticFailureSamples(semanticState.semantic_failure_samples);
      const primaryFailureFiles = Number.parseInt(
        semanticState.semantic_primary_failure_file_count ?? "0",
        10,
      ) || 0;
      const primaryFailureSamples = failureSamples.filter((failure) =>
        isPrimaryArchitectureScope(classifyArchitecturalScope(failure.file))
      );
      checks.push({
        name: "Semantic resolution diagnostics",
        ok: primaryFailureFiles === 0,
        detail: semanticFailures === 0
          ? "no compiler-resolution failures in the latest index"
          : `call_resolution=${callFailures}, public_api_extraction=${publicApiFailures}, ` +
            `actionable_primary_files=${primaryFailureFiles}` +
            (primaryFailureSamples.length === 0
              ? "; failures are outside production/configuration scope"
              : `; ${primaryFailureSamples
                  .slice(0, 5)
                  .map((failure) => `${failure.operation}:${failure.file} (${failure.message})`)
                  .join(", ")}`),
        severity: primaryFailureFiles === 0 ? "info" : "warning",
      });

      const unsupported = database
        .prepare(
          `SELECT path FROM files
           WHERE parse_status IN ('unsupported', 'unsupported_parser')
           ORDER BY path LIMIT 100`,
        )
        .all() as Array<{ path: string }>;
      const unsupportedSource = unsupported.filter((row) =>
        classifyArchitecturalScope(row.path) === "production",
      );
      const unsupportedKinds = [...new Set(
        unsupportedSource.map((row) => path.posix.extname(row.path).toLowerCase() || "extensionless"),
      )];
      checks.push({
        name: "Unsupported languages",
        ok: unsupportedSource.length === 0,
        detail: unsupportedSource.length === 0
          ? `none${unsupported.length === 0 ? "" : `; ${unsupported.length} repository metadata files use generic nodes`}`
          : `${unsupportedSource.length} source files (${unsupportedKinds.join(", ")}) use generic file metadata only`,
        severity: unsupportedSource.length === 0 ? "info" : "warning",
      });

      const unresolvedImportRows = database
        .prepare(
          `SELECT file_path AS filePath, coalesce(
                    json_extract(metadata_json, '$.import_classification'),
                    'uncategorized'
                  ) AS category
           FROM resolution_issues
           WHERE reference_kind = 'import'
             AND reason IN ('unresolved_reference', 'multi_candidate')
           ORDER BY file_path, line, column_number`,
        )
        .all() as Array<{ filePath: string; category: string }>;
      const categoryCounts = new Map<string, number>();
      for (const row of unresolvedImportRows) {
        categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
      }
      const unresolvedImportCategories = [...categoryCounts]
        .map(([category, count]) => ({ category, count }))
        .sort((left, right) => left.category.localeCompare(right.category));
      const unresolvedImports = unresolvedImportCategories.reduce(
        (sum, category) => sum + category.count,
        0,
      );
      const actionableImports = unresolvedImportRows.filter((entry) =>
        entry.category !== "external_dependency" &&
        isPrimaryArchitectureScope(classifyArchitecturalScope(entry.filePath)),
      ).length;
      checks.push({
        name: "Unresolved imports",
        ok: actionableImports === 0,
        detail: unresolvedImports === 0
          ? "none"
          : `${unresolvedImports} categorized references (${unresolvedImportCategories
              .map((entry) => `${entry.category}=${entry.count}`)
              .join(", ")}); actionable_primary=${actionableImports}`,
        severity: actionableImports === 0 ? "info" : "warning",
      });

      const dynamicSummary = database
        .prepare(
          `SELECT
             (SELECT count(*) FROM resolution_issues
               WHERE reason IN ('dynamic_relationship', 'generated_code')) AS issues,
             (SELECT count(*) FROM edges
               WHERE provenance_category = 'dynamic') AS edges,
             (SELECT count(*) FROM resolution_issues
               WHERE reason IN ('dynamic_relationship', 'generated_code')
                 AND (json_extract(metadata_json, '$.evidence.file') IS NULL
                   OR json_extract(metadata_json, '$.provenance') NOT IN ('dynamic', 'unresolved'))) +
             (SELECT count(*) FROM edges
               WHERE provenance_category = 'dynamic'
                 AND (confidence >= 1
                   OR json_extract(metadata_json, '$.evidence.file') IS NULL)) AS invalid`,
        )
        .get() as { issues: number; edges: number; invalid: number };
      const dynamicRelationships = dynamicSummary.issues + dynamicSummary.edges;
      checks.push({
        name: "Dynamic relationship labeling",
        ok: dynamicSummary.invalid === 0,
        detail: dynamicRelationships === 0
          ? "none"
          : `${dynamicRelationships} explicitly labeled candidate/unresolved facts; invalid_labels=${dynamicSummary.invalid}`,
        severity: dynamicSummary.invalid === 0 ? "info" : "warning",
      });

      const relationshipRows = database
        .prepare(
          `SELECT provenance_category AS provenance, file_path AS filePath
           FROM edges
           WHERE provenance_category IN ('verified', 'inferred', 'dynamic')`,
        )
        .all() as Array<{
          provenance: "verified" | "inferred" | "dynamic";
          filePath: string | null;
        }>;
      const primaryRelationships = relationshipRows.filter((row) =>
        isPrimaryArchitectureScope(classifyArchitecturalScope(row.filePath)),
      );
      const countPrimaryProvenance = (provenance: "verified" | "inferred" | "dynamic"): number =>
        primaryRelationships.filter((row) => row.provenance === provenance).length;
      const dynamicIssues = (
        database
          .prepare(
            `SELECT file_path AS filePath FROM resolution_issues
             WHERE reason IN ('dynamic_relationship', 'generated_code')`,
          )
          .all() as Array<{ filePath: string }>
      ).filter((row) =>
        isPrimaryArchitectureScope(classifyArchitecturalScope(row.filePath)),
      ).length;
      const actionableIssueRows = database
        .prepare(
          `SELECT file_path AS filePath
           FROM resolution_issues
           WHERE (
             reason = 'multi_candidate'
             AND reference_kind NOT IN ('reference', 'reflection')
           ) OR (
             reference_kind = 'import'
             AND coalesce(
               json_extract(metadata_json, '$.import_classification'),
               'uncategorized'
             ) <> 'external_dependency'
           ) OR (
             reason = 'unresolved_reference'
             AND reference_kind IN (
               'extends', 'implements', 'framework_route_handler',
               'framework_implementation', 'framework_mount', 'framework_hook',
               'framework_protection', 'prisma_query', 'prisma_update'
             )
           )`,
        )
        .all() as Array<{ filePath: string }>;
      const unresolvedRelationships = actionableIssueRows.filter((row) =>
        isPrimaryArchitectureScope(classifyArchitecturalScope(row.filePath)),
      ).length;
      const relationshipQuality = {
        verified: countPrimaryProvenance("verified"),
        inferred: countPrimaryProvenance("inferred"),
        dynamic: countPrimaryProvenance("dynamic") + dynamicIssues,
      };
      const denominator =
        relationshipQuality.verified +
        relationshipQuality.inferred +
        relationshipQuality.dynamic +
        unresolvedRelationships;
      const percentage = (value: number): string =>
        denominator === 0 ? "0.0" : ((value / denominator) * 100).toFixed(1);
      const verifiedPercent = denominator === 0
        ? 100
        : (relationshipQuality.verified / denominator) * 100;
      const unresolvedPercent = denominator === 0
        ? 0
        : (unresolvedRelationships / denominator) * 100;
      const relationshipQualityOk =
        verifiedPercent >= config.limits.minimumVerifiedRelationshipPercent &&
        unresolvedPercent <= config.limits.maximumUnresolvedRelationshipPercent;
      checks.push({
        name: "Relationship quality",
        ok: relationshipQualityOk,
        detail:
          `verified=${relationshipQuality.verified} (${percentage(relationshipQuality.verified)}%), ` +
          `inferred=${relationshipQuality.inferred} (${percentage(relationshipQuality.inferred)}%), ` +
          `dynamic=${relationshipQuality.dynamic} (${percentage(relationshipQuality.dynamic)}%), ` +
          `actionable_unresolved=${unresolvedRelationships} (${percentage(unresolvedRelationships)}%); ` +
          "scope=production+configuration; " +
          `thresholds verified>=${config.limits.minimumVerifiedRelationshipPercent}%, ` +
          `unresolved<=${config.limits.maximumUnresolvedRelationshipPercent}%`,
        severity: relationshipQualityOk ? "info" : "warning",
      });

      const parserFailureRows = database
        .prepare(
          `SELECT path, parse_status AS parseStatus FROM files
           WHERE parse_status IN ('parsed_with_errors', 'parse_error')
           ORDER BY path`,
        )
        .all() as Array<{ path: string; parseStatus: string }>;
      const hardFailures = parserFailureRows.filter((row) => row.parseStatus === "parse_error");
      const parserDiagnostics = parserFailureRows.filter((row) =>
        row.parseStatus === "parsed_with_errors"
      );
      const generatedFailures = hardFailures.filter((row) =>
        /(?:^|\/)(?:generated|__generated__|gen)(?:\/|$)/iu.test(row.path),
      ).length;
      const importantFailures = hardFailures.length - generatedFailures;
      checks.push({
        name: "Indexing failures",
        ok: hardFailures.length === 0,
        detail: hardFailures.length === 0
          ? "none"
          : `${hardFailures.length} files could not be parsed (important_source=${importantFailures}, generated=${generatedFailures}): ${hardFailures
              .slice(0, 20)
              .map((row) => `${row.path}[${row.parseStatus}]`)
              .join(", ")}${hardFailures.length > 20 ? ", …" : ""}`,
        severity: hardFailures.length === 0 ? "info" : "warning",
      });
      checks.push({
        name: "Parser diagnostics",
        ok: parserDiagnostics.length === 0,
        detail: parserDiagnostics.length === 0
          ? "none"
          : `${parserDiagnostics.length} files retained partial facts with syntax diagnostics: ${parserDiagnostics
              .slice(0, 20)
              .map((row) => row.path)
              .join(", ")}${parserDiagnostics.length > 20 ? ", …" : ""}`,
        severity: parserDiagnostics.length === 0 ? "info" : "warning",
      });

      try {
        const storage = database
          .prepare(
            `SELECT name, sum(pgsize) AS bytes
             FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 8`,
          )
          .all() as Array<{ name: string; bytes: number }>;
        checks.push({
          name: "Database storage",
          ok: true,
          detail: storage
            .map((entry) => `${entry.name}=${(entry.bytes / 1024 / 1024).toFixed(1)}MB`)
            .join(", "),
          severity: "info",
        });
      } catch {
        checks.push({
          name: "Database storage",
          ok: true,
          detail: "SQLite dbstat is unavailable on this runtime",
          severity: "info",
        });
      }

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
    .map((check) => `${check.ok ? "[OK]" : check.severity === "warning" ? "[!]" : "[X]"} ${check.name}: ${check.detail}`)
    .join("\n");
}
