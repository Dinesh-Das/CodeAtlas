import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildControlFlows } from "../analysis/control-flow.js";
import { buildExecutionFlows } from "../analysis/flows.js";
import { buildImpactIndex, createImpactAnalyzer } from "../analysis/impact.js";
import { indexRepository } from "../cli/index-command.js";
import { initializeRepository } from "../cli/init.js";
import { loadConfig } from "../core/config.js";
import { CodeAtlasError } from "../core/errors.js";
import { createEvidenceId, EvidenceExcerptReader } from "../ir/evidence.js";
import { loadIgnoreRules } from "../core/ignore.js";
import { workspaceExists, workspacePaths, writeJsonAtomic, writeTextAtomic } from "../core/workspace.js";
import { exportAtlasHtml } from "../export/html.js";
import { exportAtlasBundle, exportAtlasData } from "../export/json.js";
import { exportAtlasMarkdown, renderAtlasMarkdown } from "../export/markdown.js";
import { detectGitState } from "../git/changes.js";
import { detectRepository, runGit } from "../git/repository.js";
import { persistSnapshot } from "../git/snapshots.js";
import { withDetachedWorktree } from "../git/worktree.js";
import type { Atlas, AtlasGitChange, AtlasGitSymbolChange, AtlasSymbol } from "../ir/models.js";
import { loadAtlasFromDatabase } from "../ir/loader.js";
import { normalizeAtlas } from "../ir/serialization.js";
import { assertValidAtlas } from "../ir/validation.js";
import { loadV2Config, v2ConfigFingerprint } from "../rules/config.js";
import { applyDomainOverrides } from "../rules/domains.js";
import { evaluateArchitectureRules } from "../rules/engine.js";
import { buildDeterministicReview } from "../review/review.js";
import { openDatabase } from "../storage/database.js";
import type { IndexProgress } from "../core/telemetry.js";

export interface BuildResult {
  repositoryRoot: string;
  htmlPath: string;
  htmlMode: "single-file" | "bundle";
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

function resolveHtmlMode(
  configured: "single-file" | "bundle",
  options: { bundle?: boolean; singleFile?: boolean },
): "single-file" | "bundle" {
  if (options.bundle === true && options.singleFile === true) {
    throw new CodeAtlasError("Error: Choose either --bundle or --single-file, not both.");
  }
  if (options.bundle === true) return "bundle";
  if (options.singleFile === true) return "single-file";
  return configured;
}

function changedRanges(diff: string): {
  old: Array<{ start_line: number; end_line: number }>;
  current: Array<{ start_line: number; end_line: number }>;
} {
  const old: Array<{ start_line: number; end_line: number }> = [];
  const current: Array<{ start_line: number; end_line: number }> = [];
  for (const line of diff.split(/\r?\n/u)) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (match === null) continue;
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const currentStart = Number(match[3]);
    const currentCount = match[4] === undefined ? 1 : Number(match[4]);
    if (oldCount > 0) old.push({ start_line: oldStart, end_line: oldStart + oldCount - 1 });
    if (currentCount > 0) {
      current.push({ start_line: currentStart, end_line: currentStart + currentCount - 1 });
    }
  }
  return { old, current };
}

function symbolIdentity(symbol: AtlasSymbol): string {
  return [
    symbol.kind,
    symbol.language ?? "",
    symbol.qualified_name ?? symbol.name,
    symbol.signature ?? "",
  ].join("\0");
}

function touchedSymbols(
  symbols: readonly AtlasSymbol[],
  ranges: readonly { start_line: number; end_line: number }[],
): AtlasSymbol[] {
  if (ranges.length === 0) return [...symbols];
  return symbols.filter((symbol) =>
    symbol.kind === "file" ||
    symbol.location === null ||
    ranges.some((range) =>
      symbol.location!.start_line <= range.end_line && symbol.location!.end_line >= range.start_line,
    ),
  );
}

function classifySymbolChanges(
  change: Awaited<ReturnType<typeof detectGitState>>["changes"][number],
  currentSymbols: readonly AtlasSymbol[],
  previousSymbols: readonly AtlasSymbol[],
): AtlasGitSymbolChange[] {
  const previousById = new Map(previousSymbols.map((symbol) => [symbol.id, symbol]));
  const previousByIdentity = new Map<string, AtlasSymbol[]>();
  for (const symbol of previousSymbols) {
    const key = symbolIdentity(symbol);
    const bucket = previousByIdentity.get(key) ?? [];
    bucket.push(symbol);
    previousByIdentity.set(key, bucket);
  }
  const usedPrevious = new Set<string>();
  const result: AtlasGitSymbolChange[] = [];
  for (const symbol of currentSymbols) {
    let previous = previousById.get(symbol.id);
    if (previous === undefined) {
      previous = (previousByIdentity.get(symbolIdentity(symbol)) ?? [])
        .find((candidate) => !usedPrevious.has(candidate.id));
    }
    if (previous === undefined && change.kind === "renamed" && symbol.kind === "file") {
      previous = previousSymbols.find((candidate) =>
        candidate.kind === "file" && !usedPrevious.has(candidate.id),
      );
    }
    if (previous !== undefined) usedPrevious.add(previous.id);
    const status: AtlasGitSymbolChange["status"] = previous === undefined
      ? "ADDED"
      : change.kind === "renamed" || previous.file !== symbol.file
        ? "MOVED"
        : "MODIFIED";
    result.push({
      status,
      symbol_id: symbol.id,
      previous_symbol_id: previous?.id ?? null,
      name: symbol.name,
      qualified_name: symbol.qualified_name,
      kind: symbol.kind,
      file: symbol.file ?? change.path,
      previous_file: previous?.file ?? change.previousPath,
    });
  }
  for (const previous of previousSymbols) {
    if (usedPrevious.has(previous.id)) continue;
    result.push({
      status: "DELETED",
      symbol_id: null,
      previous_symbol_id: previous.id,
      name: previous.name,
      qualified_name: previous.qualified_name,
      kind: previous.kind,
      file: change.path,
      previous_file: previous.file ?? change.previousPath ?? change.path,
    });
  }
  return result.sort((left, right) =>
    `${left.status}\0${left.qualified_name ?? left.name}\0${left.symbol_id ?? left.previous_symbol_id ?? ""}`
      .localeCompare(`${right.status}\0${right.qualified_name ?? right.name}\0${right.symbol_id ?? right.previous_symbol_id ?? ""}`),
  );
}

async function sourceDiffForChange(
  repositoryRoot: string,
  baseCommit: string,
  change: Awaited<ReturnType<typeof detectGitState>>["changes"][number],
): Promise<string> {
  const paths = change.previousPath !== null && change.previousPath !== change.path
    ? [change.previousPath, change.path]
    : [change.path];
  let diff = await runGit(repositoryRoot, [
    "diff", "--unified=3", "--no-color", "--find-renames=50%", baseCommit, "--", ...paths,
  ], true);
  if (diff.length === 0 && change.kind === "added") {
    try {
      const body = await readFile(path.join(repositoryRoot, change.path), "utf8");
      const lines = body.split(/\r?\n/u);
      diff = [
        "diff --git a/dev/null b/" + change.path,
        "--- /dev/null",
        "+++ b/" + change.path,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
      ].join("\n");
    } catch {
      // Binary/unreadable untracked files remain represented by their file status.
    }
  }
  const maxChars = 200_000;
  return diff.length <= maxChars ? diff : `${diff.slice(0, maxChars)}\n... [diff truncated by CodeAtlas]`;
}

async function loadAtlasAtCommit(repositoryRoot: string, commit: string): Promise<Atlas> {
  return withDetachedWorktree(repositoryRoot, commit, async (worktreeRoot) => {
    const build = await buildRepository(worktreeRoot, {
      gitBase: "HEAD",
      gitHead: "HEAD",
      snapshot: false,
      bundle: false,
    });
    return JSON.parse(await readFile(path.join(build.currentDirectory, "atlas.json"), "utf8")) as Atlas;
  });
}

async function mapGitChanges(
  atlas: Awaited<ReturnType<typeof loadAtlasFromDatabase>>,
  previousAtlas: Atlas,
  repositoryRoot: string,
  baseCommit: string,
  changes: Awaited<ReturnType<typeof detectGitState>>["changes"],
  impact: ReturnType<typeof createImpactAnalyzer>,
): Promise<AtlasGitChange[]> {
  const excerptReader = new EvidenceExcerptReader(repositoryRoot);
  return Promise.all(changes.map(async (change, index) => {
    const sourceDiff = await sourceDiffForChange(repositoryRoot, baseCommit, change);
    const ranges = changedRanges(sourceDiff);
    const previousPath = change.previousPath ?? change.path;
    const currentCandidates = atlas.symbols.filter((symbol) => symbol.file === change.path);
    const previousCandidates = previousAtlas.symbols.filter((symbol) => symbol.file === previousPath);
    const currentSymbols = change.kind === "added" || (change.kind === "renamed" && ranges.current.length === 0)
      ? currentCandidates
      : change.kind === "deleted" || ranges.current.length === 0
        ? []
        : touchedSymbols(currentCandidates, ranges.current);
    const previousSymbols = change.kind === "deleted" || (change.kind === "renamed" && ranges.old.length === 0)
      ? previousCandidates
      : change.kind === "added" || ranges.old.length === 0
        ? []
        : touchedSymbols(previousCandidates, ranges.old);
    const symbolChanges = classifySymbolChanges(change, currentSymbols, previousSymbols);
    const symbolIds = symbolChanges.flatMap((symbol) => symbol.symbol_id === null ? [] : [symbol.symbol_id]);
    const impactPaths = symbolIds.flatMap((id) => impact(id, { depth: 8, limit: 25 })).slice(0, 200);
    const impactedSymbolIds = [...new Set(impactPaths.map((item) => item.impacted))]
      .sort((left, right) => left.localeCompare(right));
    const evidenceIds: string[] = [];
    const evidenceRanges = change.kind === "deleted" ? [] : ranges.current;
    for (const range of evidenceRanges) {
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
      line_ranges: change.kind === "deleted" ? ranges.old : ranges.current,
      symbol_ids: symbolIds,
      symbol_changes: symbolChanges,
      impacted_symbol_ids: impactedSymbolIds,
      impact_paths: impactPaths,
      source_diff: sourceDiff,
      related_test_ids: [],
      rule_violation_ids: [],
      review_finding_ids: [],
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
    singleFile?: boolean;
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
  const htmlMode = resolveHtmlMode(v2Config.html.mode, options);

  const irStarted = performance.now();
  const database = openDatabase(paths.database, { readonly: true });
  let atlas;
  try {
    atlas = await loadAtlasFromDatabase({
      database,
      repositoryRoot: index.repository.root,
      repositoryId: index.repository.id,
      repositoryName: index.repository.name,
      gitAvailable: index.repository.gitAvailable,
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
  const analyzeImpact = createImpactAnalyzer(atlas);
  const gitStarted = performance.now();
  let headCommit = index.repository.headCommit;
  let baseCommit = headCommit;
  if (!index.repository.gitAvailable && (options.gitBase !== undefined || options.gitHead !== undefined)) {
    throw new CodeAtlasError(
      "Error: Git base/head options require a Git repository. This directory is running in filesystem mode.",
    );
  }
  if (index.repository.gitAvailable) {
    const requestedHead = options.gitHead ?? "HEAD";
    headCommit = (await runGit(index.repository.root, ["rev-parse", requestedHead])).trim();
    if (headCommit !== index.repository.headCommit) {
      throw new Error(`Git head ${requestedHead} (${headCommit}) is not the checked-out commit ${index.repository.headCommit}; check it out before building its architecture.`);
    }
    baseCommit = options.gitBase === undefined
      ? headCommit
      : (await runGit(index.repository.root, ["rev-parse", options.gitBase])).trim();
    const gitState = await detectGitState(
      index.repository.root,
      baseCommit,
      headCommit,
    );
    const ignoreRules = await loadIgnoreRules(index.repository.root);
    const relevantChanges = gitState.changes.filter((change) =>
      !ignoreRules.ignores(change.path) &&
      (change.previousPath === null || !ignoreRules.ignores(change.previousPath)),
    );
    const previousAtlas = relevantChanges.length === 0
      ? atlas
      : await loadAtlasAtCommit(index.repository.root, baseCommit);
    atlas.git_changes = await mapGitChanges(
      atlas,
      previousAtlas,
      index.repository.root,
      baseCommit,
      relevantChanges,
      analyzeImpact,
    );
  } else {
    atlas.git_changes = [];
  }
  const gitMs = performance.now() - gitStarted;

  atlas.rules = v2Config.architecture.rules;
  atlas.rule_violations = evaluateArchitectureRules(atlas, atlas.rules);
  const impactStarted = performance.now();
  atlas.impact = buildImpactIndex(atlas);
  const impactMs = performance.now() - impactStarted;
  atlas.review_findings = buildDeterministicReview(atlas);
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  for (const change of atlas.git_changes) {
    const impacted = new Set([...change.symbol_ids, ...change.impacted_symbol_ids]);
    change.related_test_ids = [...impacted]
      .filter((id) => {
        const symbol = symbolById.get(id);
        return symbol !== undefined && (
          symbol.kind === "test" ||
          /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[^/]+$/iu.test(symbol.file ?? "")
        );
      })
      .sort((left, right) => left.localeCompare(right));
    change.rule_violation_ids = atlas.rule_violations
      .filter((violation) =>
        impacted.has(violation.source_id) ||
        (violation.target_id !== null && impacted.has(violation.target_id)) ||
        violation.path.some((id) => impacted.has(id)),
      )
      .map((violation) => violation.id)
      .sort((left, right) => left.localeCompare(right));
    change.review_finding_ids = atlas.review_findings
      .filter((finding) =>
        finding.changed_symbol_ids.some((id) => change.symbol_ids.includes(id)) ||
        finding.impacted_symbol_ids.some((id) => impacted.has(id)),
      )
      .map((finding) => finding.id)
      .sort((left, right) => left.localeCompare(right));
  }

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
  const bundlePath = htmlMode === "bundle" ? path.join(index.repository.root, "codeatlas") : null;
  const htmlPath = bundlePath === null
    ? path.join(index.repository.root, "codeatlas.html")
    : path.join(bundlePath, "index.html");
  const markdownPath = path.join(index.repository.root, "CODEATLAS.md");
  const commonExports = [
    exportAtlasMarkdown(atlas, markdownPath),
    writeTextAtomic(path.join(paths.agent, "overview.md"), renderAtlasMarkdown(atlas)),
    writeJsonAtomic(path.join(paths.agent, "manifest.json"), {
      schema_version: atlas.schema_version,
      snapshot_id: atlas.snapshot.id,
      overview: "overview.md",
      canonical_ir: "../current/atlas.json",
      mcp_command: "codeatlas mcp",
    }),
  ];
  if (bundlePath === null) {
    await Promise.all([exportAtlasHtml(atlas, htmlPath), ...commonExports]);
  } else {
    await Promise.all([
      exportAtlasBundle(atlas, bundlePath),
      exportAtlasHtml(atlas, htmlPath),
      ...commonExports,
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
    current_fingerprint: index.fingerprint,
    generations: index.generations,
    v2_config_fingerprint: v2ConfigFingerprint(v2Config),
    git_available: index.repository.gitAvailable,
    git_base: index.repository.gitAvailable ? baseCommit : null,
    git_head: index.repository.gitAvailable ? headCommit : null,
    parsed_files: index.work.filesParsed,
    reused_files: Math.max(0, index.files - index.work.filesParsed),
    timings_ms: timingsMs,
  });
  return {
    repositoryRoot: index.repository.root,
    htmlPath,
    htmlMode,
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
