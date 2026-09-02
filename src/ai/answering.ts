import type { Atlas, AtlasEvidence, AtlasFlow, AtlasSymbol } from "../ir/models.js";
import { isDefiniteImpactRelationship } from "../analysis/impact.js";
import { rankSymbolSearch } from "../analysis/simplification.js";
import {
  classifyArchitecturalScope,
  isPrimaryArchitectureScope,
  isPrimaryArchitectureSymbol,
} from "../analysis/scope.js";
import { validateEvidenceIds } from "../ir/evidence-validation.js";

export interface AtlasClaim {
  text: string;
  fact_class: "source_fact" | "graph_inference" | "semantic_inference" | "llm_interpretation";
  evidence_ids: string[];
}

export interface AtlasAnswer {
  question: string;
  answer: string;
  claims: AtlasClaim[];
  evidence: AtlasEvidence[];
  provenance: "STATIC_ANALYSIS";
}

export interface ArchitectureAnswerQuality {
  score: number;
  passed: boolean;
  checks: {
    grounded: boolean;
    primaryScopeOnly: boolean;
    identifiesStartingPoint: boolean;
    architectureSpecific: boolean;
    nonRepetitive: boolean;
  };
}

const STOP_WORDS = new Set([
  "a", "ai", "an", "and", "agent", "architecture", "coding", "codeatlas", "context", "developer",
  "does", "explain", "for", "give", "how", "is", "of", "overview", "point", "project", "provide",
  "repository", "start", "starting", "the", "to", "tool", "what", "where", "why", "work",
]);

function terms(question: string): string[] {
  return [...new Set(question.toLocaleLowerCase().split(/[^a-z0-9_]+/u)
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term)))];
}

function bestFlow(atlas: Atlas, candidates: readonly AtlasSymbol[]): AtlasFlow | null {
  const ids = new Set(candidates.map((symbol) => symbol.id));
  return atlas.flows.find((flow) => ids.has(flow.entrypoint_id) || flow.steps.some((step) => ids.has(step.symbol_id))) ?? null;
}

const EXPLANATION_KINDS = new Set([
  "endpoint", "function", "method", "class", "interface", "module", "file", "database_model",
]);

function boundedEvidence(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flatMap((group) => group.slice(0, 2)))].slice(0, 4);
}

function architecturalSearchText(symbol: AtlasSymbol, atlas: Atlas): string {
  const domains = symbol.domain_ids.flatMap((id) =>
    atlas.domains.find((domain) => domain.id === id)?.name ?? [],
  );
  return [symbol.name, symbol.qualified_name, symbol.file, symbol.kind, symbol.signature, ...domains]
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLocaleLowerCase();
}

function primaryEntrypoints(atlas: Atlas): AtlasSymbol[] {
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  return atlas.entrypoint_ids
    .map((id) => symbolById.get(id))
    .filter((symbol): symbol is AtlasSymbol =>
      symbol !== undefined && isPrimaryArchitectureSymbol(symbol) && symbol.evidence_ids.length > 0
    )
    .sort((left, right) => {
      const publicPriority = (symbol: AtlasSymbol): number => symbol.visibility === "public" ? 1 : 0;
      return publicPriority(right) - publicPriority(left) ||
        (left.file ?? "").localeCompare(right.file ?? "") ||
        left.id.localeCompare(right.id);
    });
}

function primaryDomainSummary(atlas: Atlas): Array<{
  name: string;
  files: number;
  evidenceIds: string[];
}> {
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  return atlas.domains
    .map((domain) => {
      const members = domain.member_ids
        .map((id) => symbolById.get(id))
        .filter((symbol): symbol is AtlasSymbol =>
          symbol !== undefined && isPrimaryArchitectureSymbol(symbol)
        );
      const files = new Set(members.map((member) => member.file).filter((file): file is string => file !== null));
      return {
        name: domain.name,
        files: files.size,
        evidenceIds: boundedEvidence(domain.evidence_ids, ...members.map((member) => member.evidence_ids)),
      };
    })
    .filter((domain) => domain.files > 0 && domain.evidenceIds.length > 0)
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));
}

function describedStartingPoint(symbol: AtlasSymbol): string {
  const name = symbol.qualified_name ?? symbol.name;
  return symbol.file === null ? name : `${name} in ${symbol.file}`;
}

export function answerFromAtlas(atlas: Atlas, question: string): AtlasAnswer {
  const normalizedQuestion = question.toLocaleLowerCase();
  const asksForAgentContext = /\b(?:ai|agent)\b/u.test(normalizedQuestion) &&
    /\b(?:context|mcp|architecture)\b/u.test(normalizedQuestion);
  const asksForArchitectureOverview = asksForAgentContext ||
    /\b(?:architecture|architectural|overview|onboard|starting point|start)\b/u.test(normalizedQuestion);
  const queryTerms = terms(question);
  const rankedCandidates = atlas.symbols
    .filter((symbol) => isPrimaryArchitectureSymbol(symbol) && EXPLANATION_KINDS.has(symbol.kind))
    .map((symbol) => {
      const coreText = architecturalSearchText(symbol, atlas);
      const matchedTerms = queryTerms.filter((term) => coreText.includes(term)).length;
      return {
        symbol,
        matchedTerms,
        score: rankSymbolSearch(symbol, question, atlas) + matchedTerms * 200,
      };
    })
    .filter((item) => item.symbol.evidence_ids.length > 0);
  let candidates = rankedCandidates
    .filter((item) => queryTerms.length === 0 || item.matchedTerms > 0)
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.id.localeCompare(right.symbol.id))
    .slice(0, 8)
    .map((item) => item.symbol);
  if (asksForArchitectureOverview && candidates.length === 0) {
    const entrypoints = new Set(atlas.entrypoint_ids);
    const kindPriority = new Map([
      ["endpoint", 6],
      ["function", 5],
      ["class", 4],
      ["method", 3],
      ["interface", 2],
      ["module", 1],
      ["file", 0],
    ]);
    candidates = rankedCandidates
      .sort((left, right) => {
        const priority = (symbol: AtlasSymbol): number =>
          (entrypoints.has(symbol.id) ? 1_000 : 0) +
          (symbol.domain_ids.length > 0 ? 100 : 0) +
          (symbol.visibility === "public" ? 10 : 0) +
          (kindPriority.get(symbol.kind) ?? 0);
        return priority(right.symbol) - priority(left.symbol) ||
          left.symbol.id.localeCompare(right.symbol.id);
      })
      .slice(0, 8)
      .map((item) => item.symbol);
  }
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  const flow = bestFlow(atlas, candidates);
  const claims: AtlasClaim[] = [];
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  if (asksForArchitectureOverview) {
    const domains = primaryDomainSummary(atlas);
    if (domains.length > 0) {
      const largest = domains.slice(0, 5);
      claims.push({
        text: `The repository has ${domains.length} primary architecture regions. The largest are ${largest
          .map((domain) => `${domain.name} (${domain.files} ${domain.files === 1 ? "file" : "files"})`)
          .join(", ")}.`,
        fact_class: "graph_inference",
        evidence_ids: boundedEvidence(...largest.map((domain) => domain.evidenceIds)),
      });
    }
  }
  if (asksForAgentContext) {
    const contextComponents = ["repositoryOverviewIr", "findSymbolIr", "impactIr", "evidenceIr"]
      .map((name) => atlas.symbols.find((symbol) =>
        symbol.name === name && isPrimaryArchitectureSymbol(symbol),
      ))
      .filter((symbol): symbol is AtlasSymbol => symbol !== undefined);
    if (contextComponents.length === 4) {
      claims.push({
        text: "AI agents get indexed repository context through the MCP query layer: repositoryOverviewIr provides the repository view, findSymbolIr locates code entities, impactIr traces change reach, and evidenceIr returns source-grounded evidence.",
        fact_class: "semantic_inference",
        evidence_ids: boundedEvidence(...contextComponents.map((symbol) => symbol.evidence_ids)),
      });
    }
  }
  if (asksForArchitectureOverview) {
    const detectedEntrypoints = primaryEntrypoints(atlas).slice(0, 5);
    const startingPoints = detectedEntrypoints.length > 0
      ? detectedEntrypoints
      : candidates.filter((symbol) => symbol.evidence_ids.length > 0).slice(0, 5);
    if (startingPoints.length > 0) {
      claims.push({
        text: detectedEntrypoints.length > 0
          ? `Start with ${startingPoints.map(describedStartingPoint).join(", ")}. These are the detected production entrypoints.`
          : `Start with ${startingPoints.map(describedStartingPoint).join(", ")}. No formal production entrypoint was detected, so these are the highest-ranked public architecture symbols.`,
        fact_class: "semantic_inference",
        evidence_ids: boundedEvidence(...startingPoints.map((symbol) => symbol.evidence_ids)),
      });
    }
  }
  const matchingDomains = atlas.domains
    .map((domain) => ({
      domain,
      score: queryTerms.reduce((score, term) => {
        const name = domain.name.toLocaleLowerCase();
        return score + (name === term ? 10 : term.length >= 4 && name.includes(term) ? 5 : 0);
      }, 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.domain.id.localeCompare(right.domain.id))
    .slice(0, 2);
  for (const { domain } of matchingDomains) {
    const members = domain.member_ids.map((id) => symbolById.get(id))
      .filter((symbol): symbol is AtlasSymbol =>
        symbol !== undefined && candidateIds.has(symbol.id) &&
        !["file", "module", "interface"].includes(symbol.kind),
      )
      .sort((left, right) => rankSymbolSearch(right, question, atlas) - rankSymbolSearch(left, question, atlas))
      .slice(0, 4);
    const evidenceIds = boundedEvidence(...members.map((member) => member.evidence_ids));
    if (evidenceIds.length > 0) {
      claims.push({
        text: `The ${domain.name} architecture region spans ${domain.file_ids.length} files and its relevant components include ${members.map((member) => member.qualified_name ?? member.name).join(", ")}.`,
        fact_class: "graph_inference",
        evidence_ids: evidenceIds,
      });
    }
  }
  if (flow !== null && !asksForArchitectureOverview) {
    const path = flow.paths?.find((candidate) => !candidate.cycle_detected) ?? flow.paths?.[0];
    const symbolIds = path?.symbol_ids ?? flow.steps.map((step) => step.symbol_id);
    const names = symbolIds.map((id) => symbolById.get(id)?.qualified_name ?? symbolById.get(id)?.name ?? id);
    const relationshipEvidence = (path?.relationship_ids ?? [])
      .flatMap((id) => atlas.relationships.find((relationship) => relationship.id === id)?.evidence_ids ?? []);
    claims.push({
      text: `${flow.name} has an evidence-linked execution path through ${names.join(" → ")}.`,
      fact_class: "graph_inference",
      evidence_ids: boundedEvidence(
        relationshipEvidence,
        ...symbolIds.map((id) => symbolById.get(id)?.evidence_ids ?? []),
      ),
    });
  }
  for (const symbol of asksForArchitectureOverview ? [] : candidates.slice(0, 3)) {
    const outgoing = atlas.relationships.filter((relationship) =>
      relationship.source === symbol.id &&
      isDefiniteImpactRelationship(relationship) &&
      ["CALLS", "HANDLES", "TRIGGERS", "IMPLEMENTED_BY", "IMPORTS", "QUERIES", "UPDATES"].includes(relationship.type),
    ).sort((left, right) => {
      const priority = (relationship: typeof left): number => {
        const name = symbolById.get(relationship.target)?.name.toLocaleLowerCase() ?? "";
        return /overview|find|search|symbol|impact|flow|evidence|rule|snapshot/u.test(name) ? 1 : 0;
      };
      return priority(right) - priority(left) || left.id.localeCompare(right.id);
    }).slice(0, 6);
    if (outgoing.length > 0) {
      const targets = [...new Set(outgoing.map((relationship) =>
        symbolById.get(relationship.target)?.qualified_name ?? symbolById.get(relationship.target)?.name ?? relationship.target,
      ))];
      const normalizedName = symbol.name.toLocaleLowerCase();
      const connection = /^create.*server$/u.test(normalizedName)
        ? "orchestrates evidence-backed query components including"
        : /^start.*server$/u.test(normalizedName)
          ? "starts the server through"
          : "directly connects to";
      claims.push({
        text: `${symbol.qualified_name ?? symbol.name}${symbol.file === null ? "" : ` in ${symbol.file}`} ${connection} ${targets.join(", ")}.`,
        fact_class: "graph_inference",
        evidence_ids: boundedEvidence(symbol.evidence_ids, ...outgoing.map((relationship) => relationship.evidence_ids)),
      });
    } else {
      claims.push({
        text: `${symbol.qualified_name ?? symbol.name} is a ${symbol.kind}${symbol.file === null ? "" : ` in ${symbol.file}`}.`,
        fact_class: "source_fact",
        evidence_ids: boundedEvidence(symbol.evidence_ids),
      });
    }
  }
  const answerClaims = claims.slice(0, 5);
  const evidenceIds = [...new Set(answerClaims.flatMap((claim) => claim.evidence_ids))];
  const grounding = validateEvidenceIds(atlas, evidenceIds);
  const validIds = new Set(grounding.valid.map((item) => item.id));
  const validClaims = answerClaims.filter((claim) =>
    claim.evidence_ids.length > 0 && claim.evidence_ids.every((id) => validIds.has(id)),
  );
  const citedIds = new Set(validClaims.flatMap((claim) => claim.evidence_ids));
  const evidence = grounding.valid.filter((item) => citedIds.has(item.id));
  return {
    question,
    answer: validClaims.length === 0
      ? "CodeAtlas does not have enough source evidence to answer this question."
      : validClaims.map((claim) => claim.text).join(" "),
    claims: validClaims,
    evidence,
    provenance: "STATIC_ANALYSIS",
  };
}

export function evaluateArchitectureAnswer(
  atlas: Atlas,
  answer: AtlasAnswer,
): ArchitectureAnswerQuality {
  const validEvidence = new Set(atlas.evidence.map((item) => item.id));
  const citedEvidence = new Set(answer.claims.flatMap((claim) => claim.evidence_ids));
  const grounded = answer.claims.length > 0 && answer.evidence.length > 0 &&
    answer.claims.every((claim) =>
      claim.evidence_ids.length > 0 && claim.evidence_ids.every((id) => validEvidence.has(id))
    ) && answer.evidence.every((item) => citedEvidence.has(item.id));
  const primaryScopeOnly = answer.evidence.length > 0 && answer.evidence.every((item) =>
    isPrimaryArchitectureScope(classifyArchitecturalScope(item.file))
  );
  const normalized = answer.answer.toLocaleLowerCase();
  const identifiesStartingPoint = /\bstart with\b|\bentrypoints?\b/u.test(normalized);
  const architectureSpecific = /\barchitecture regions?\b|\bmcp query layer\b|\bproduction entrypoints?\b/u
    .test(normalized);
  const normalizedClaims = answer.claims.map((claim) =>
    claim.text.toLocaleLowerCase().replace(/\s+/gu, " ").trim()
  );
  const nonRepetitive = new Set(normalizedClaims).size === normalizedClaims.length &&
    !/\b([a-z_][a-z0-9_]*)\s*,\s*\1\b/iu.test(answer.answer);
  const checks = {
    grounded,
    primaryScopeOnly,
    identifiesStartingPoint,
    architectureSpecific,
    nonRepetitive,
  };
  const score = Object.values(checks).filter(Boolean).length / Object.keys(checks).length;
  return { score, passed: score >= 0.8 && grounded && primaryScopeOnly, checks };
}
