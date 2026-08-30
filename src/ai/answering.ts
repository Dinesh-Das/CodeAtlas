import type { Atlas, AtlasEvidence, AtlasFlow, AtlasSymbol } from "../ir/models.js";

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

const STOP_WORDS = new Set(["a", "an", "and", "does", "how", "is", "the", "to", "what", "where", "why", "work"]);

function terms(question: string): string[] {
  return [...new Set(question.toLocaleLowerCase().split(/[^a-z0-9_]+/u)
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term)))];
}

function rank(symbol: AtlasSymbol, queryTerms: readonly string[]): number {
  const name = symbol.name.toLocaleLowerCase();
  const text = [symbol.name, symbol.qualified_name, symbol.file, symbol.kind]
    .filter((value): value is string => value !== null).join(" ").toLocaleLowerCase();
  return queryTerms.reduce((score, term) => score +
    (name === term ? 12 : name.includes(term) ? 6 : text.includes(term) ? 2 : 0), 0);
}

function bestFlow(atlas: Atlas, candidates: readonly AtlasSymbol[]): AtlasFlow | null {
  const ids = new Set(candidates.map((symbol) => symbol.id));
  return atlas.flows.find((flow) => ids.has(flow.entrypoint_id) || flow.steps.some((step) => ids.has(step.symbol_id))) ?? null;
}

export function answerFromAtlas(atlas: Atlas, question: string): AtlasAnswer {
  const queryTerms = terms(question);
  const candidates = atlas.symbols.map((symbol) => ({ symbol, score: rank(symbol, queryTerms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.symbol.id.localeCompare(right.symbol.id))
    .slice(0, 8).map((item) => item.symbol);
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  const flow = bestFlow(atlas, candidates);
  const claims: AtlasClaim[] = [];
  if (flow !== null) {
    const names = flow.steps.map((step) => symbolById.get(step.symbol_id)?.qualified_name ?? symbolById.get(step.symbol_id)?.name ?? step.symbol_id);
    claims.push({
      text: `${flow.name} executes through ${names.join(" → ")}.`,
      fact_class: "graph_inference",
      evidence_ids: [...new Set(flow.steps.flatMap((step) => step.evidence_ids))],
    });
  } else {
    for (const symbol of candidates.slice(0, 5)) {
      claims.push({
        text: `${symbol.qualified_name ?? symbol.name} is a ${symbol.kind}${symbol.file === null ? "" : ` in ${symbol.file}`}.`,
        fact_class: "source_fact",
        evidence_ids: symbol.evidence_ids,
      });
    }
  }
  const evidenceIds = new Set(claims.flatMap((claim) => claim.evidence_ids));
  const evidence = atlas.evidence.filter((item) => evidenceIds.has(item.id));
  const validIds = new Set(evidence.map((item) => item.id));
  const validClaims = claims.filter((claim) =>
    claim.evidence_ids.length > 0 && claim.evidence_ids.every((id) => validIds.has(id)),
  );
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
