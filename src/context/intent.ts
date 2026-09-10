import type { Atlas } from "../ir/models.js";
import { symbolSearchTerms } from "../analysis/simplification.js";
import type { ChangeContext, ChangeIntentKind } from "./packet.js";

const STOP_WORDS = new Set([
  "a", "add", "an", "and", "are", "as", "at", "be", "by", "change", "code", "does",
  "affected", "around", "become", "becomes", "for", "from", "how", "i", "in", "is", "it",
  "new", "of", "on", "or", "output", "please", "repository", "should", "that", "the", "this",
  "to", "update", "we", "what", "where", "which", "with",
]);

const APPROVED_VOCABULARY: ReadonlyArray<{ pattern: RegExp; terms: readonly string[] }> = [
  { pattern: /\b(?:auth|authentication|login|sign[- ]?in)\b/iu, terms: ["auth", "authenticate", "login"] },
  { pattern: /\b(?:rate limit|throttl)/iu, terms: ["rate", "limit", "throttle"] },
  { pattern: /\b(?:database|persist|storage|repository)\b/iu, terms: ["database", "storage", "repository"] },
  { pattern: /\b(?:test|spec|fixture|coverage)\b/iu, terms: ["test", "spec", "fixture"] },
  { pattern: /\b(?:http|api|endpoint|route)\b/iu, terms: ["api", "endpoint", "route"] },
  { pattern: /\b(?:config|configuration|setting)\b/iu, terms: ["config", "configuration"] },
  { pattern: /\bmcp\b/iu, terms: ["mcp", "server", "query"] },
  { pattern: /\b(?:index|indexed|retrieval|retrieve|search)\b/iu, terms: ["index", "search", "query", "store"] },
  { pattern: /\b(?:evidence|provenance|grounded)\b/iu, terms: ["evidence", "provenance", "source"] },
  { pattern: /\b(?:response|result|serialize|output)\b/iu, terms: ["response", "result", "serialize"] },
];

function classify(task: string): ChangeIntentKind {
  if (/\b(?:document|documentation|readme|guide|adr)\b/iu.test(task)) return "documentation";
  if (/\b(?:refactor|rename|extract|move|split|simplif)\b/iu.test(task)) return "refactoring";
  if (/\b(?:bug|broken|crash|error|fail|fix|incorrect|regression)\b/iu.test(task)) return "bug_fix";
  if (/\b(?:architecture|flow|explain|overview|onboard)\b/iu.test(task)) return "architecture";
  if (/\b(?:add|change|create|implement|introduce|support|update)\b/iu.test(task)) return "feature";
  if (/\b(?:tests?|specs?|fixtures?|coverage)\b/iu.test(task)) return "test_change";
  return "unknown";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export type ChangeTaskIntent = ChangeContext["intent"];

export function classifyChangeTask(task: string, atlas: Atlas): ChangeTaskIntent {
  const rawTerms = symbolSearchTerms(task);
  const vocabularyTerms = APPROVED_VOCABULARY.flatMap((entry) =>
    entry.pattern.test(task) ? entry.terms : []
  );
  const terms = unique([...rawTerms, ...vocabularyTerms])
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term))
    .slice(0, 24);
  const quoted = [...task.matchAll(/[`'"]([^`'"]{1,200})[`'"]/gu)]
    .map((match) => match[1] ?? "");
  const identifiers = [...task.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/gu)]
    .map((match) => match[0]);
  const explicitFiles = unique([
    ...quoted,
    ...task.matchAll(/(?:^|\s)((?:\.?\.?[/\\])?[\w@.+-]+(?:[/\\][\w@.+-]+)+\.[A-Za-z0-9]+)/gu),
    ...task.matchAll(/\b([\w@.+-]+\.(?:[A-Za-z][A-Za-z0-9]*))\b/gu),
  ].flatMap((value) => typeof value === "string" ? [value] : [value[1] ?? ""]))
    .filter((value) => /[/\\]|\.[A-Za-z0-9]+$/u.test(value))
    .map((value) => value.replaceAll("\\", "/").replace(/^\.\//u, ""));
  const explicitEndpoints = unique([
    ...task.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/[A-Za-z0-9_/:{}.*-]+)/giu),
    ...quoted.filter((value) => value.startsWith("/")),
  ].flatMap((value) => typeof value === "string" ? [value] : [value[1] ?? ""]));
  const domainNames = atlas.domains.map((domain) => domain.name);
  const explicitDomains = domainNames.filter((name) => {
    const domainTerms = symbolSearchTerms(name);
    return domainTerms.length > 0 && domainTerms.every((term) => rawTerms.includes(term));
  });
  const exactNames = new Set(atlas.symbols.flatMap((symbol) => [
    symbol.name,
    symbol.qualified_name ?? "",
  ]));
  const foldedNames = new Set([...exactNames].map((value) => value.toLocaleLowerCase()));
  const exactIdentifierTokens = task.match(/\b[A-Za-z_$][A-Za-z0-9_$:-]*\b/gu) ?? [];
  const codeLikeIdentifiers = exactIdentifierTokens.filter((value) =>
    /[a-z0-9][A-Z]|[_$:]/u.test(value) || /^[A-Z][a-z]/u.test(value)
  );
  const explicitSymbols = unique([
    ...quoted.filter((value) => foldedNames.has(value.toLocaleLowerCase())),
    ...identifiers.filter((value) => exactNames.has(value)),
    ...codeLikeIdentifiers.filter((value) => exactNames.has(value)),
  ])
    .filter((value) => !explicitFiles.includes(value) && !explicitEndpoints.includes(value))
    .filter((value) => foldedNames.has(value.toLocaleLowerCase()));
  return {
    kind: classify(task),
    terms,
    explicit_symbols: explicitSymbols,
    explicit_files: explicitFiles,
    explicit_endpoints: explicitEndpoints,
    explicit_domains: explicitDomains,
  };
}

export function ftsTaskQuery(intent: ChangeTaskIntent): string | null {
  const terms = intent.terms
    .filter((term) => /^[\p{L}\p{N}_$-]+$/u.test(term))
    .slice(0, 12);
  return terms.length === 0 ? null : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
