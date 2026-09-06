import { rankSymbolSearch, symbolSearchTerms } from "../analysis/simplification.js";
import { isPrimaryArchitectureSymbol } from "../analysis/scope.js";
import type { Atlas, AtlasSymbol } from "../ir/models.js";
import type { SearchResult } from "../storage/search.js";
import type { ChangeTaskIntent } from "./intent.js";
import type { RankedContextSymbol } from "./packet.js";

export interface ContextRetrievalInput {
  fts: readonly SearchResult[];
  changedSymbolIds: ReadonlySet<string>;
  prioritizeChangedSymbols: boolean;
  searchTextBySymbolId?: ReadonlyMap<string, string>;
}

const EDIT_CANDIDATE_KINDS = new Set([
  "class", "configuration", "database_model", "database_table", "endpoint", "file", "function",
  "interface", "method", "module", "test", "type",
]);
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[^/]+$/iu;

function identifierOverlap(symbol: AtlasSymbol, intent: ChangeTaskIntent): number {
  const symbolTerms = new Set(symbolSearchTerms([
    symbol.name,
    symbol.qualified_name,
    symbol.file,
  ].filter((value): value is string => value !== null).join(" ")));
  return intent.terms.filter((term) => symbolTerms.has(term)).length;
}

function roleScore(symbol: AtlasSymbol, intent: ChangeTaskIntent): number {
  if (intent.kind === "test_change") {
    return symbol.kind === "test" || /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\./iu.test(symbol.file ?? "")
      ? 260
      : 0;
  }
  if (intent.kind === "architecture") {
    return ["endpoint", "module", "file", "class", "interface", "database_model"]
      .includes(symbol.kind) ? 120 : 0;
  }
  return ["function", "method", "class", "endpoint", "database_model", "configuration"]
    .includes(symbol.kind) ? 100 : 0;
}

function exactReferences(symbol: AtlasSymbol, intent: ChangeTaskIntent): string[] {
  const name = symbol.name.toLocaleLowerCase();
  const qualified = symbol.qualified_name?.toLocaleLowerCase() ?? "";
  return intent.explicit_symbols.filter((reference) => {
    const normalized = reference.toLocaleLowerCase();
    return normalized === name || normalized === qualified;
  });
}

export function rankChangeCandidates(
  atlas: Atlas,
  intent: ChangeTaskIntent,
  retrieval: ContextRetrievalInput,
): RankedContextSymbol[] {
  const retrievalQuery = intent.terms.join(" ");
  const ftsPosition = new Map(retrieval.fts.map((result, index) => [result.id, index]));
  const domainIds = new Set(atlas.domains
    .filter((domain) => intent.explicit_domains.includes(domain.name))
    .flatMap((domain) => domain.member_ids));
  return atlas.symbols.flatMap((symbol): RankedContextSymbol[] => {
    if (symbol.file === null || symbol.location === null || symbol.evidence_ids.length === 0) return [];
    const exact = exactReferences(symbol, intent);
    if (!EDIT_CANDIDATE_KINDS.has(symbol.kind) && exact.length === 0) return [];
    if (intent.kind !== "test_change" && (symbol.kind === "test" || TEST_FILE.test(symbol.file))) return [];
    const symbolFile = symbol.file;
    const reasons: string[] = [];
    const textScore = Math.max(0, rankSymbolSearch(
      symbol,
      retrievalQuery,
      retrieval.searchTextBySymbolId?.get(symbol.id) ?? atlas,
    ));
    let score = textScore;
    if (exact.length > 0) {
      score += 1_500;
      reasons.push(`exact symbol: ${exact.join(", ")}`);
    }
    if (intent.explicit_files.some((file) => symbolFile === file || symbolFile.endsWith(`/${file}`))) {
      score += 1_000;
      reasons.push("explicit file");
    }
    if (intent.explicit_endpoints.some((endpoint) =>
      rankSymbolSearch(
        symbol,
        endpoint,
        retrieval.searchTextBySymbolId?.get(symbol.id) ?? atlas,
      ) > 0 && symbol.kind === "endpoint"
    )) {
      score += 1_300;
      reasons.push("explicit endpoint");
    }
    const position = ftsPosition.get(symbol.id);
    if (position !== undefined) {
      score += Math.max(80, 500 - position * 10);
      reasons.push("FTS match");
    }
    if (domainIds.has(symbol.id)) {
      score += 450;
      reasons.push("domain match");
    }
    if (retrieval.prioritizeChangedSymbols && retrieval.changedSymbolIds.has(symbol.id)) {
      score += 1_200;
      reasons.push("changed symbol");
    }
    const overlap = identifierOverlap(symbol, intent);
    if (overlap > 0) {
      score += overlap * 180;
      reasons.push(`identifier terms: ${overlap}`);
    }
    if (textScore === 0 && reasons.length === 0) return [];
    score += roleScore(symbol, intent);
    if (isPrimaryArchitectureSymbol(symbol)) score += 80;
    if (symbol.visibility === "public") score += 30;
    score += symbol.confidence * 40;
    if (score <= 120 && reasons.length === 0) return [];
    return [{
      symbolId: symbol.id,
      score,
      reasons: reasons.length === 0 ? ["task vocabulary match"] : reasons,
      targetResolution: null,
    }];
  }).sort((left, right) => right.score - left.score || left.symbolId.localeCompare(right.symbolId));
}
