import path from "node:path";
import picomatch from "picomatch";
import { architectureService } from "../service/architecture-service.js";
import type { Atlas, AtlasSymbol } from "../ir/models.js";
import { loadV2Config } from "../rules/config.js";
import type { CodeAtlasV2Config, KnowledgeOwner } from "../rules/types.js";
import { workspacePaths, writeJsonAtomic, writeTextAtomic } from "../core/workspace.js";

export interface KnowledgeFinding {
  code: string;
  severity: "warning" | "error";
  message: string;
  file: string;
  line: number;
  evidence_ids: string[];
}

export interface KnowledgeDocument {
  file: string;
  title: string;
  kind: string;
  status: string | null;
  owner: string | null;
  last_reviewed: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  evidence_ids: string[];
}

export interface KnowledgeSystem {
  id: string;
  name: string;
  owner: string | null;
  purpose: string | null;
  member_ids: string[];
  entrypoint_id: string | null;
  contract_ids: string[];
  validation_command: string | null;
  provenance: "human_config" | "generated_graph";
  evidence_ids: string[];
}

export interface KnowledgeReport {
  schema_version: "1.0";
  snapshot_id: string;
  generated_at: string;
  systems: KnowledgeSystem[];
  journeys: CodeAtlasV2Config["knowledge"]["journeys"];
  invariants: CodeAtlasV2Config["knowledge"]["invariants"];
  canonical_names: CodeAtlasV2Config["knowledge"]["canonical_names"];
  documents: KnowledgeDocument[];
  findings: KnowledgeFinding[];
}

function stringMetadata(symbol: AtlasSymbol, key: string): string | null {
  const value = symbol.metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function documentation(atlas: Atlas): KnowledgeDocument[] {
  const byFile = new Map<string, AtlasSymbol[]>();
  for (const symbol of atlas.symbols) {
    if (symbol.kind !== "documentation" || symbol.file === null) continue;
    const items = byFile.get(symbol.file) ?? [];
    items.push(symbol);
    byFile.set(symbol.file, items);
  }
  return [...byFile.entries()].map(([file, symbols]) => {
    symbols.sort((left, right) => (left.location?.start_line ?? 1) - (right.location?.start_line ?? 1));
    const first = symbols[0]!;
    return {
      file,
      title: first.name,
      kind: stringMetadata(first, "document_kind") ?? "documentation",
      status: stringMetadata(first, "adr_status"),
      owner: stringMetadata(first, "adr_owner"),
      last_reviewed: stringMetadata(first, "last_reviewed"),
      supersedes: stringMetadata(first, "supersedes"),
      superseded_by: stringMetadata(first, "superseded_by"),
      evidence_ids: [...new Set(symbols.flatMap((symbol) => symbol.evidence_ids))].slice(0, 4),
    };
  }).sort((left, right) => left.file.localeCompare(right.file));
}

function resolveSymbol(atlas: Atlas, selector: string | null): AtlasSymbol | null {
  if (selector === null) return null;
  const normalized = selector.toLocaleLowerCase();
  const matches = atlas.symbols.filter((symbol) =>
    symbol.id === selector || symbol.name.toLocaleLowerCase() === normalized ||
    symbol.qualified_name?.toLocaleLowerCase() === normalized
  );
  return matches.length === 1 ? matches[0]! : null;
}

function configEvidence(atlas: Atlas): string[] {
  return atlas.evidence.filter((item) => item.file === ".codeatlas.yml").map((item) => item.id).slice(0, 2);
}

function configuredSystem(atlas: Atlas, owner: KnowledgeOwner): KnowledgeSystem {
  const matchers = owner.include.map((pattern) => picomatch(pattern, { dot: true }));
  const members = atlas.symbols.filter((symbol) =>
    symbol.file !== null && matchers.some((matches) => matches(symbol.file!))
  );
  const entrypoint = resolveSymbol(atlas, owner.entrypoint);
  const contracts = owner.contracts.flatMap((selector) => resolveSymbol(atlas, selector) ?? []);
  return {
    id: owner.id,
    name: owner.id,
    owner: owner.owner,
    purpose: owner.purpose,
    member_ids: members.map((symbol) => symbol.id).sort(),
    entrypoint_id: entrypoint?.id ?? null,
    contract_ids: [...new Set(contracts.map((symbol) => symbol.id))].sort(),
    validation_command: owner.validation_command,
    provenance: "human_config",
    evidence_ids: configEvidence(atlas),
  };
}

function generatedSystems(atlas: Atlas): KnowledgeSystem[] {
  return atlas.domains.slice(0, 50).map((domain) => ({
    id: domain.id,
    name: domain.name,
    owner: null,
    purpose: null,
    member_ids: domain.member_ids,
    entrypoint_id: domain.entrypoint_ids[0] ?? null,
    contract_ids: domain.member_ids.filter((id) => {
      const kind = atlas.symbols.find((symbol) => symbol.id === id)?.kind;
      return kind !== undefined && ["endpoint", "http_contract", "event", "topic", "database_model"].includes(kind);
    }),
    validation_command: null,
    provenance: "generated_graph" as const,
    evidence_ids: domain.evidence_ids,
  })).filter((system) => system.entrypoint_id !== null || system.contract_ids.length > 0).slice(0, 30);
}

function documentationFindings(
  documents: readonly KnowledgeDocument[],
  config: CodeAtlasV2Config,
  now: Date,
): KnowledgeFinding[] {
  const adrDocuments = documents.filter((document) => document.kind === "adr");
  const knownNames = adrDocuments.map((document) =>
    `${document.file.toLocaleLowerCase()}\n${path.posix.basename(document.file, path.posix.extname(document.file)).toLocaleLowerCase()}\n${document.title.toLocaleLowerCase()}`
  );
  return adrDocuments.flatMap((document): KnowledgeFinding[] => {
    const location = { file: document.file, line: 1, evidence_ids: document.evidence_ids };
    const findings: KnowledgeFinding[] = [];
    if (document.status === null || document.status === "unknown") findings.push({
      code: "adr_status_missing", severity: "warning", message: "ADR status is missing or unrecognized.", ...location,
    });
    if (document.owner === null) findings.push({
      code: "adr_owner_missing", severity: "warning", message: "ADR owner is missing.", ...location,
    });
    if (document.last_reviewed === null) findings.push({
      code: "adr_review_date_missing", severity: "warning", message: "ADR review date is missing.", ...location,
    });
    else if (!/^\d{4}-\d{2}-\d{2}$/u.test(document.last_reviewed)) findings.push({
      code: "adr_review_date_invalid", severity: "warning", message: "ADR review date must use YYYY-MM-DD.", ...location,
    });
    else {
      const reviewed = new Date(`${document.last_reviewed}T00:00:00.000Z`);
      const ageDays = Math.floor((now.getTime() - reviewed.getTime()) / 86_400_000);
      if (!Number.isNaN(ageDays) && ageDays > config.knowledge.max_documentation_age_days) findings.push({
        code: "adr_stale",
        severity: "warning",
        message: `ADR was last reviewed ${ageDays} days ago; limit is ${config.knowledge.max_documentation_age_days}.`,
        ...location,
      });
    }
    for (const [field, target] of [["supersedes", document.supersedes], ["superseded by", document.superseded_by]] as const) {
      if (target === null || knownNames.some((known) => known.includes(target.toLocaleLowerCase()))) continue;
      findings.push({
        code: "adr_supersession_target_missing",
        severity: "warning",
        message: `ADR ${field} target '${target}' does not resolve to an indexed ADR.`,
        ...location,
      });
    }
    return findings;
  });
}

function configurationFindings(
  atlas: Atlas,
  config: CodeAtlasV2Config,
  systems: readonly KnowledgeSystem[],
): KnowledgeFinding[] {
  const evidence_ids = configEvidence(atlas);
  const location = { file: ".codeatlas.yml", line: 1, evidence_ids };
  const findings: KnowledgeFinding[] = [];
  for (const system of systems) {
    if (system.provenance === "generated_graph") {
      findings.push({
        code: "system_owner_missing",
        severity: "warning",
        message: `${system.name} has graph members but no pinned owner or purpose.`,
        file: atlas.symbols.find((symbol) => system.member_ids.includes(symbol.id))?.file ?? ".codeatlas.yml",
        line: 1,
        evidence_ids: system.evidence_ids,
      });
      continue;
    }
    if (system.member_ids.length === 0) findings.push({
      code: "owner_scope_empty", severity: "error", message: `${system.id} owner scope matches no indexed symbols.`, ...location,
    });
    if (system.entrypoint_id === null) findings.push({
      code: "system_entrypoint_missing", severity: "warning", message: `${system.id} has no resolved entrypoint.`, ...location,
    });
    if (system.contract_ids.length === 0) findings.push({
      code: "system_contract_missing", severity: "warning", message: `${system.id} has no resolved principal contract.`, ...location,
    });
    if (system.validation_command === null) findings.push({
      code: "system_validation_missing", severity: "warning", message: `${system.id} has no validation command.`, ...location,
    });
  }
  for (const journey of config.knowledge.journeys) {
    if (resolveSymbol(atlas, journey.entrypoint) === null) findings.push({
      code: "journey_entrypoint_missing", severity: "error", message: `${journey.id} entrypoint '${journey.entrypoint}' does not resolve uniquely.`, ...location,
    });
  }
  for (const invariant of config.knowledge.invariants) {
    const matches = invariant.applies_to.some((pattern) => {
      const matcher = picomatch(pattern, { dot: true });
      return atlas.symbols.some((symbol) => symbol.file !== null && matcher(symbol.file));
    });
    if (!matches) findings.push({
      code: "invariant_scope_empty", severity: "warning", message: `${invariant.id} applies to no indexed file.`, ...location,
    });
  }
  for (const canonical of config.knowledge.canonical_names) {
    if (resolveSymbol(atlas, canonical.symbol) === null) findings.push({
      code: "canonical_symbol_missing", severity: "error", message: `Canonical name target '${canonical.symbol}' does not resolve uniquely.`, ...location,
    });
  }
  return findings;
}

export function buildKnowledgeReport(
  atlas: Atlas,
  config: CodeAtlasV2Config,
  now = new Date(),
): KnowledgeReport {
  const documents = documentation(atlas);
  const configured = config.knowledge.owners.map((owner) => configuredSystem(atlas, owner));
  const coveredMembers = new Set(configured.flatMap((system) => system.member_ids));
  const unowned = generatedSystems(atlas).filter((system) =>
    !system.member_ids.some((id) => coveredMembers.has(id))
  );
  const systems = [...configured, ...unowned];
  return {
    schema_version: "1.0",
    snapshot_id: atlas.snapshot.id,
    generated_at: now.toISOString(),
    systems,
    journeys: config.knowledge.journeys,
    invariants: config.knowledge.invariants,
    canonical_names: config.knowledge.canonical_names,
    documents,
    findings: [
      ...documentationFindings(documents, config, now),
      ...configurationFindings(atlas, config, systems),
    ],
  };
}

function documentLinks(report: KnowledgeReport, pattern: RegExp): string[] {
  return report.documents.filter((document) => pattern.test(`${document.file} ${document.title}`))
    .slice(0, 12)
    .map((document) => `- [${document.title}](../../${document.file}) — human documentation`);
}

export function renderAgentMap(report: KnowledgeReport): string {
  const lines = [
    "# CodeAtlas agent map",
    "",
    `Snapshot: ${report.snapshot_id}`,
    "",
    "This is a short table of contents. Follow linked evidence before changing code.",
    "",
    "## Generated architecture",
    "",
    "- [Guided system viewer](../../codeatlas.html)",
    "- [Architecture overview](overview.md)",
    "- [Canonical IR](../current/atlas.json)",
    "- [Knowledge findings](knowledge.json)",
    "",
    "## Critical systems",
    "",
    ...report.systems.slice(0, 20).map((system) =>
      `- **${system.name}** — owner: ${system.owner ?? "missing"}; purpose: ${system.purpose ?? "missing"}; entrypoint: ${system.entrypoint_id ?? "missing"}; contracts: ${system.contract_ids.length}; validation: ${system.validation_command ?? "missing"} (${system.provenance})`
    ),
    "",
    "## Critical journeys",
    "",
    ...(report.journeys.length === 0
      ? ["- Missing: pin critical journeys in `.codeatlas.yml`."]
      : report.journeys.slice(0, 15).map((journey) =>
        `- **${journey.name}** — ${journey.purpose}; entrypoint: ${journey.entrypoint} (human_config)`
      )),
    "",
    "## Invariants",
    "",
    ...(report.invariants.length === 0
      ? ["- Missing: pin change invariants in `.codeatlas.yml`."]
      : report.invariants.slice(0, 15).map((invariant) =>
        `- **${invariant.id}** — ${invariant.statement} (human_config)`
      )),
    "",
    "## Canonical names",
    "",
    ...(report.canonical_names.length === 0
      ? ["- No canonical names are pinned."]
      : report.canonical_names.slice(0, 15).map((item) =>
        `- **${item.name}** — ${item.symbol} (human_config)`
      )),
    "",
    "## Product and plans",
    "",
    ...documentLinks(report, /product|plan|roadmap|requirements|specification/iu),
    "",
    "## Reliability and security",
    "",
    ...documentLinks(report, /reliability|runbook|operations|security|threat/iu),
    "",
    "## Architecture decisions",
    "",
    ...report.documents.filter((document) => document.kind === "adr").slice(0, 20).map((document) =>
      `- [${document.title}](../../${document.file}) — status: ${document.status ?? "missing"}; owner: ${document.owner ?? "missing"}; reviewed: ${document.last_reviewed ?? "missing"} (human documentation)`
    ),
    "",
    "## Actionable knowledge gaps",
    "",
    ...report.findings.slice(0, 25).map((finding) =>
      `- **${finding.severity} · ${finding.code}** — ${finding.message} (${finding.file}:${finding.line})`
    ),
  ];
  if (lines.length <= 149) return `${lines.join("\n")}\n`;
  return `${lines.slice(0, 147).join("\n")}\n\n- Additional items are available in [knowledge.json](knowledge.json).\n`;
}

export async function writeKnowledgeArtifacts(
  repositoryRoot: string,
  report: KnowledgeReport,
): Promise<{ mapPath: string; reportPath: string }> {
  const paths = workspacePaths(repositoryRoot);
  const mapPath = path.join(paths.agent, "map.md");
  const reportPath = path.join(paths.agent, "knowledge.json");
  await Promise.all([
    writeTextAtomic(mapPath, renderAgentMap(report)),
    writeJsonAtomic(reportPath, report),
  ]);
  return { mapPath, reportPath };
}

export async function createKnowledgeArtifacts(startPath = process.cwd()): Promise<{
  report: KnowledgeReport;
  mapPath: string;
  reportPath: string;
}> {
  const context = await architectureService.load(startPath);
  const config = await loadV2Config(context.repositoryRoot);
  const report = buildKnowledgeReport(context.atlas, config);
  return { report, ...await writeKnowledgeArtifacts(context.repositoryRoot, report) };
}

export function formatKnowledgeReport(report: KnowledgeReport): string {
  const errors = report.findings.filter((finding) => finding.severity === "error").length;
  const warnings = report.findings.length - errors;
  return [
    `Knowledge system ${report.snapshot_id}`,
    `  ${report.systems.length} critical systems`,
    `  ${report.journeys.length} pinned journeys`,
    `  ${report.invariants.length} pinned invariants`,
    `  ${report.documents.length} documentation files`,
    `  ${errors} errors, ${warnings} warnings`,
    ...report.findings.map((finding) =>
      `[${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message} (${finding.file}:${finding.line})`
    ),
  ].join("\n");
}
