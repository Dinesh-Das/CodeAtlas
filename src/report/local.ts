import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { sha256 } from "../core/hashing.js";
import { workspacePaths, writeJsonAtomic } from "../core/workspace.js";
import { detectRepository, runGit } from "../git/repository.js";
import { openDatabase } from "../storage/database.js";
import { SqliteQueryStore } from "../storage/query-store.js";
import { getStatus } from "../cli/status.js";
import { CODEATLAS_VERSION } from "../version.js";

const REPORT_SCHEMA_VERSION = "1.0";
const QUERY_SUITE = ["service", "route", "repository", "test", "config"] as const;
const RAW_CONTENT_COLUMNS = new Set([
  "body",
  "excerpt",
  "prompt",
  "source",
  "source_code",
  "source_text",
]);
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)$|credentials(?:\.|$)|secrets?(?:\.|$))/iu;

export interface LocalProofReport {
  schema_version: typeof REPORT_SCHEMA_VERSION;
  generated_at: string;
  codeatlas_version: string;
  repository: {
    name: string;
    commit: string;
    dirty: boolean;
    indexed_commit: string | null;
    fingerprint: string;
    url?: string;
  };
  environment: {
    operating_system: "linux" | "macos" | "windows";
    architecture: string;
    node_version: string;
  };
  index: {
    synchronized: boolean;
    files: number;
    symbols: number;
    relationships: number;
    database_bytes: number;
    generated_artifact_bytes: number;
  };
  graph_quality: {
    measurement: "observed_fact_distribution";
    verified: number;
    inferred: number;
    dynamic: number;
    unresolved: number;
    ground_truth_precision_recall_measured: false;
  };
  performance: {
    suite_id: "standard-symbol-search-v1";
    samples: number;
    result_rows: number;
    latency_ms: { p50: number; p95: number; maximum: number };
    observed_rss_mib: number;
    rss_delta_mib: number;
  };
  privacy: {
    local_only: true;
    source_excerpt_included: false;
    query_or_prompt_text_included: false;
    raw_content_columns: string[];
    indexed_sensitive_paths: number;
    passed: boolean;
  };
  reproducibility: {
    command: string;
    query_suite_sha256: string;
    input_manifest_sha256: string;
  };
}

function operatingSystem(): LocalProofReport["environment"]["operating_system"] {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

async function directoryBytes(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const itemPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(itemPath);
    else if (entry.isFile()) total += (await stat(itemPath)).size;
  }
  return total;
}

function normalizedRepositoryUrl(value: string): string | null {
  if (value === "") return null;
  const scp = value.match(/^git@([^:]+):(.+)$/u);
  const candidate = scp === null
    ? value.replace(/^ssh:\/\/git@/u, "https://")
    : `https://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    return url.href.replace(/\.git\/?$/u, "").replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export async function createLocalProofReport(
  startPath = process.cwd(),
  options: { includeRepositoryUrl?: boolean } = {},
): Promise<LocalProofReport> {
  const repository = await detectRepository(startPath);
  const status = await getStatus(repository.root);
  const workspace = workspacePaths(repository.root);
  const database = openDatabase(workspace.database, { readonly: true });
  let quality: Record<string, number>;
  let rawContentColumns: string[];
  let indexedSensitivePaths: number;
  try {
    quality = Object.fromEntries(
      (database.prepare(
        "SELECT provenance_category AS category, count(*) AS count FROM edges GROUP BY provenance_category",
      ).all() as Array<{ category: string; count: number }>).map((entry) => [entry.category, entry.count]),
    );
    quality.unresolved = database.prepare("SELECT count(*) FROM resolution_issues").pluck().get() as number;
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>;
    rawContentColumns = tables.flatMap((table) => {
      const safeName = table.name.replaceAll('"', '""');
      const columns = database.prepare(`PRAGMA table_info("${safeName}")`).all() as Array<{ name: string }>;
      return columns
        .filter((column) => RAW_CONTENT_COLUMNS.has(column.name.toLowerCase()))
        .map((column) => `${table.name}.${column.name}`);
    }).sort();
    const indexedPaths = database.prepare("SELECT path FROM files").pluck().all() as string[];
    indexedSensitivePaths = indexedPaths.filter((filePath) =>
      SENSITIVE_PATH.test(filePath.replaceAll("\\", "/"))
    ).length;
  } finally {
    database.close();
  }

  const store = new SqliteQueryStore(workspace.database);
  store.searchSymbols(QUERY_SUITE[0], 10);
  const rssBefore = process.memoryUsage().rss;
  const latencies: number[] = [];
  let resultRows = 0;
  for (let repetition = 0; repetition < 5; repetition += 1) {
    for (const query of QUERY_SUITE) {
      const startedAt = performance.now();
      const result = store.searchSymbols(query, 10);
      latencies.push(performance.now() - startedAt);
      resultRows += result.items.length;
    }
  }
  const rssAfter = process.memoryUsage().rss;
  const databaseBytes = (await stat(workspace.database)).size;
  const querySuiteSha256 = sha256(JSON.stringify(QUERY_SUITE));
  const inputManifestSha256 = sha256(JSON.stringify({
    codeatlas_version: CODEATLAS_VERSION,
    commit: repository.headCommit,
    fingerprint: status.currentFingerprint,
    node_version: process.version,
    operating_system: operatingSystem(),
    architecture: process.arch,
    query_suite_sha256: querySuiteSha256,
  }));
  const repositoryUrl = options.includeRepositoryUrl === true && repository.gitAvailable
    ? normalizedRepositoryUrl((await runGit(repository.root, ["remote", "get-url", "origin"], true)).trim())
    : null;
  const report: LocalProofReport = {
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    codeatlas_version: CODEATLAS_VERSION,
    repository: {
      name: repository.name,
      commit: repository.headCommit,
      dirty: status.dirty,
      indexed_commit: status.indexedCommit,
      fingerprint: status.currentFingerprint,
      ...(repositoryUrl === null ? {} : { url: repositoryUrl }),
    },
    environment: {
      operating_system: operatingSystem(),
      architecture: process.arch,
      node_version: process.version,
    },
    index: {
      synchronized: status.synchronized,
      files: status.files,
      symbols: status.symbols,
      relationships: status.edges,
      database_bytes: databaseBytes,
      generated_artifact_bytes: await directoryBytes(workspace.current),
    },
    graph_quality: {
      measurement: "observed_fact_distribution",
      verified: quality.verified ?? 0,
      inferred: quality.inferred ?? 0,
      dynamic: quality.dynamic ?? 0,
      unresolved: quality.unresolved ?? 0,
      ground_truth_precision_recall_measured: false,
    },
    performance: {
      suite_id: "standard-symbol-search-v1",
      samples: latencies.length,
      result_rows: resultRows,
      latency_ms: {
        p50: rounded(percentile(latencies, 0.5)),
        p95: rounded(percentile(latencies, 0.95)),
        maximum: rounded(Math.max(...latencies)),
      },
      observed_rss_mib: rounded(rssAfter / 1024 / 1024),
      rss_delta_mib: rounded((rssAfter - rssBefore) / 1024 / 1024),
    },
    privacy: {
      local_only: true,
      source_excerpt_included: false,
      query_or_prompt_text_included: false,
      raw_content_columns: rawContentColumns,
      indexed_sensitive_paths: indexedSensitivePaths,
      passed: rawContentColumns.length === 0 && indexedSensitivePaths === 0,
    },
    reproducibility: {
      command: "codeatlas report . --output <file>",
      query_suite_sha256: querySuiteSha256,
      input_manifest_sha256: inputManifestSha256,
    },
  };
  return report;
}

export async function writeLocalProofReport(
  report: LocalProofReport,
  outputPath: string,
): Promise<string> {
  const resolved = path.resolve(outputPath);
  await writeJsonAtomic(resolved, report);
  return resolved;
}

export function formatLocalProofReport(report: LocalProofReport): string {
  return [
    `CodeAtlas local proof report (${report.repository.name}@${report.repository.commit.slice(0, 12)})`,
    `Index: ${report.index.files} files, ${report.index.symbols} symbols, ${report.index.relationships} relationships`,
    `Search: p50 ${report.performance.latency_ms.p50} ms, p95 ${report.performance.latency_ms.p95} ms (${report.performance.samples} samples)`,
    `Storage: ${(report.index.database_bytes / 1024 / 1024).toFixed(2)} MiB database`,
    `Memory: ${report.performance.observed_rss_mib} MiB observed RSS`,
    `Privacy: ${report.privacy.passed ? "passed" : "review required"}; no source excerpts or prompts included`,
    `Manifest: ${report.reproducibility.input_manifest_sha256}`,
  ].join("\n");
}
