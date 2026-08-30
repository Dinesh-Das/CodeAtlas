import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildControlFlows } from "../analysis/control-flow.js";
import { buildExecutionFlows } from "../analysis/flows.js";
import { buildImpactIndex, createImpactAnalyzer } from "../analysis/impact.js";
import { indexRepository } from "../cli/index-command.js";
import { initializeRepository } from "../cli/init.js";
import { loadConfig } from "../core/config.js";
import { createEvidenceId, EvidenceExcerptReader } from "../ir/evidence.js";
import { loadIgnoreRules } from "../core/ignore.js";
import { workspaceExists, workspacePaths, writeJsonAtomic, writeTextAtomic } from "../core/workspace.js";
import { exportAtlasHtml } from "../export/html.js";
import { exportAtlasBundle, exportAtlasData } from "../export/json.js";
import { exportAtlasMarkdown, renderAtlasMarkdown } from "../export/markdown.js";
import { detectGitState } from "../git/changes.js";
import { detectRepository, runGit } from "../git/repository.js";
import { persistSnapshot } from "../git/snapshots.js";
import type { AtlasGitChange } from "../ir/models.js";
import { loadAtlasFromDatabase } from "../ir/loader.js";
import { normalizeAtlas } from "../ir/serialization.js";
import { assertValidAtlas } from "../ir/validation.js";
import { loadV2Config } from "../rules/config.js";
import { applyDomainOverrides } from "../rules/domains.js";
import { evaluateArchitectureRules } from "../rules/engine.js";
import { buildDeterministicReview } from "../review/review.js";
import { openDatabase } from "../storage/database.js";
import type { IndexProgress } from "../core/telemetry.js";

export interface BuildResult {
  repositoryRoot: string;
  htmlPath: string;
  markdownPath: string;
  currentDirectory: string;
  snapshotId: string;
  snapshotCreated: boolean;
  bundlePath: string | null;
  initialized: boolean;
  parsedFiles: number;
  reusedFiles: number;
  statistics: {
    files: number;
    symbols: number;
    relationships: number;
    entrypoints: number;
    domains: number;
    flows: number;
    controlFlows: number;
    ruleViolations: number;
    reviewFindings: number;
  };
  timingsMs: BuildTimings;
}

export interface BuildTimings {
  indexing: number;
  ir: number;
  flows: number;
  controlFlow: number;
  impact: number;
  git: number;
  export: number;
  snapshot: number;
  total: number;
}

function changedRanges(diff: string): Array<{ start_line: number; end_line: number }> {
  const ranges: Array<{ start_line: number; end_line: number }> = [];
  for (const line of diff.split(/\r?\n/u)) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push({ start_line: start, end_line: start + count - 1 });
  }
  return ranges;
}

async function mapGitChanges(
  atlas: Awaited<ReturnType<typeof loadAtlasFromDatabase>>,
  repositoryRoot: string,
  baseCommit: string,
  changes: Awaited<ReturnType<typeof detectGitState>>["changes"],
  impact: ReturnType<typeof createImpactAnalyzer>,
): Promise<AtlasGitChange[]> {
  const excerptReader = new EvidenceExcerptReader(repositoryRoot);
  return Promise.all(changes.map(async (change, index) => {
    const ranges = change.kind === "added"
      ? []
      : changedRanges(await runGit(repositoryRoot, [
          "diff", "--unified=0", "--no-color", baseCommit, "--", change.path,
        ], true));
    const candidates = atlas.symbols.filter((symbol) => symbol.file === change.path);
    const symbols = ranges.length === 0
      ? candidates
      : candidates.filter((symbol) => symbol.kind === "file" || symbol.location === null || ranges.some((range) =>
          symbol.location!.start_line <= range.end_line && symbol.location!.end_line >= range.start_line,
        ));
    const symbolIds = symbols.map((symbol) => symbol.id);
    const evidenceIds: string[] = [];
    for (const range of ranges) {
      const id = createEvidenceId({
        file: change.path,
        startLine: range.start_line,
        startColumn: 0,
        endLine: range.end_line,
        endColumn: 0,
      });
      evidenceIds.push(id);
      if (!atlas.evidence.some((item) => item.id === id)) {
        atlas.evidence.push({
          id,
          file: change.path,
          start_line: range.start_line,
          start_column: 0,
          end_line: range.end_line,
          end_column: 0,
          symbol_id: null,
          relationship_id: null,
          kind: "git",
          excerpt: await excerptReader.excerpt(change.path, range.start_line, range.end_line),
          content_hash: null,
        });
      }
    }
    return {
      id: `git-change:${atlas.snapshot.id}:${index}:${change.kind}:${change.path}`,
      status: change.kind === "added" ? "ADDED" as const
        : change.kind === "deleted" ? "DELETED" as const
        : change.kind === "renamed" ? "MOVED" as const
        : "MODIFIED" as const,
      file: change.path,
      previous_file: change.previousPath,
      line_ranges: ranges,
      symbol_ids: symbolIds,
      impact_paths: symbolIds.flatMap((id) => impact(id, { depth: 8, limit: 25 })).slice(0, 200),
      evidence_ids: evidenceIds,
    };
  }));
}

export async function buildRepository(
  startPath = process.cwd(),
  options: {
    full?: boolean;
    snapshot?: boolean;
    gitBase?: string;
    gitHead?: string;
    bundle?: boolean;
    onProgress?: (progress: IndexProgress) => void;
  } = {},
): Promise<BuildResult> {
  const totalStarted = performance.now();
  const repository = await detectRepository(startPath);
  const initialized = !(await workspaceExists(repository.root));
  const indexStarted = performance.now();
  const index = initialized
    ? await initializeRepository(repository.root, {
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      })
    : await indexRepository(repository.root, options.full ?? false, {
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      });
  const indexMs = performance.now() - indexStarted;
  const paths = workspacePaths(index.repository.root);
  const config = await loadConfig(index.repository.root);
  const v2Config = await loadV2Config(index.repository.root);

  const irStarted = performance.now();
  const database = openDatabase(paths.database, { readonly: true });
  let atlas;
  try {
    atlas = await loadAtlasFromDatabase({
      database,
      repositoryRoot: index.repository.root,
      repositoryId: index.repository.id,
      repositoryName: index.repository.name,
      headCommit: index.repository.headCommit,
      branch: index.repository.branch,
    });
  } finally {
    database.close();
  }
  const irMs = performance.now() - irStarted;

  const flowStarted = performance.now();
  applyDomainOverrides(atlas, v2Config);
  atlas.flows = buildExecutionFlows(atlas, {
    maxDepth: Math.min(config.limits.maxTraversalDepth, v2Config.analysis.max_call_depth),
    maxSteps: config.limits.maxExecutionPaths * 10,
  });
  const flowsMs = performance.now() - flowStarted;
  const cfgStarted = performance.now();
  atlas.control_flows = await buildControlFlows(atlas, index.repository.root);
  const cfgMs = performance.now() - cfgStarted;
  const impactStarted = performance.now();
  atlas.impact = buildImpactIndex(atlas);
  const analyzeImpact = createImpactAnalyzer(atlas);
  const impactMs = performance.now() - impactStarted;
  const gitStarted = performance.now();
  const requestedHead = options.gitHead ?? "HEAD";
  const headCommit = (await runGit(index.repository.root, ["rev-parse", requestedHead])).trim();
  if (headCommit !== index.repository.headCommit) {
    throw new Error(`Git head ${requestedHead} (${headCommit}) is not the checked-out commit ${index.repository.headCommit}; check it out before building its architecture.`);
  }
  const baseCommit = options.gitBase === undefined
    ? headCommit
    : (await runGit(index.repository.root, ["rev-parse", options.gitBase])).trim();
  const gitState = await detectGitState(
    index.repository.root,
    baseCommit,
    headCommit,
  );
  const ignoreRules = await loadIgnoreRules(index.repository.root);
  atlas.git_changes = await mapGitChanges(
    atlas,
    index.repository.root,
    baseCommit,
    gitState.changes.filter((change) =>
      !ignoreRules.ignores(change.path) &&
      (change.previousPath === null || !ignoreRules.ignores(change.previousPath)),
    ),
    analyzeImpact,
  );
  const gitMs = performance.now() - gitStarted;

  atlas.rules = v2Config.architecture.rules;
  atlas.rule_violations = evaluateArchitectureRules(atlas, atlas.rules);
  atlas.review_findings = buildDeterministicReview(atlas);

  atlas.statistics = {
    ...atlas.statistics,
    flows: atlas.flows.length,
    control_flows: atlas.control_flows.length,
    rule_violations: atlas.rule_violations.length,
    review_findings: atlas.review_findings.length,
  };
  atlas = normalizeAtlas(atlas);
  assertValidAtlas(atlas);

  const exportStarted = performance.now();
  await exportAtlasData(atlas, paths.current);
  const htmlPath = path.join(index.repository.root, "codeatlas.html");
  const markdownPath = path.join(index.repository.root, "CODEATLAS.md");
  await Promise.all([
    exportAtlasHtml(atlas, htmlPath),
    exportAtlasMarkdown(atlas, markdownPath),
    writeTextAtomic(path.join(paths.agent, "overview.md"), renderAtlasMarkdown(atlas)),
    writeJsonAtomic(path.join(paths.agent, "manifest.json"), {
      schema_version: atlas.schema_version,
      snapshot_id: atlas.snapshot.id,
      overview: "overview.md",
      canonical_ir: "../current/atlas.json",
      mcp_command: "codeatlas mcp",
    }),
  ]);
  const bundlePath = options.bundle === true ? path.join(index.repository.root, "codeatlas") : null;
  if (bundlePath !== null) {
    await Promise.all([
      exportAtlasBundle(atlas, bundlePath),
      exportAtlasHtml(atlas, path.join(bundlePath, "index.html")),
    ]);
  }
  const exportMs = performance.now() - exportStarted;
  const snapshotStarted = performance.now();
  const snapshotCreated = options.snapshot !== false;
  if (snapshotCreated) await persistSnapshot(atlas, paths.snapshots);
  const snapshotMs = performance.now() - snapshotStarted;
  const timingsMs = {
    indexing: Number(indexMs.toFixed(2)),
    ir: Number(irMs.toFixed(2)),
    flows: Number(flowsMs.toFixed(2)),
    controlFlow: Number(cfgMs.toFixed(2)),
    impact: Number(impactMs.toFixed(2)),
    git: Number(gitMs.toFixed(2)),
    export: Number(exportMs.toFixed(2)),
    snapshot: Number(snapshotMs.toFixed(2)),
    total: Number((performance.now() - totalStarted).toFixed(2)),
  };
  await writeJsonAtomic(path.join(paths.current, "build.json"), {
    schema_version: atlas.schema_version,
    snapshot_id: atlas.snapshot.id,
    parsed_files: index.work.filesParsed,
    reused_files: Math.max(0, index.files - index.work.filesParsed),
    timings_ms: timingsMs,
  });
  return {
    repositoryRoot: index.repository.root,
    htmlPath,
    markdownPath,
    currentDirectory: paths.current,
    snapshotId: atlas.snapshot.id,
    snapshotCreated,
    bundlePath,
    initialized,
    parsedFiles: index.work.filesParsed,
    reusedFiles: Math.max(0, index.files - index.work.filesParsed),
    statistics: {
      files: atlas.statistics.files,
      symbols: atlas.statistics.symbols,
      relationships: atlas.statistics.relationships,
      entrypoints: atlas.statistics.entrypoints,
      domains: atlas.statistics.domains,
      flows: atlas.statistics.flows,
      controlFlows: atlas.statistics.control_flows,
      ruleViolations: atlas.statistics.rule_violations,
      reviewFindings: atlas.statistics.review_findings,
    },
    timingsMs,
  };
}
