export type AgentOperation = "search" | "prepare_change" | "trace" | "get_evidence" | "native_fallback";

const ROUTES: Array<{ operation: Exclude<AgentOperation, "native_fallback">; terms: RegExp }> = [
  {
    operation: "prepare_change",
    terms: /\b(?:add|change|edit|fix|implement|migrate|refactor|remove|rename|review|affected tests?|blast radius|plan)\b/iu,
  },
  {
    operation: "trace",
    terms: /\b(?:trace|flow|journey|path|call chain|request lifecycle|how .* reaches|from .* to)\b/iu,
  },
  {
    operation: "get_evidence",
    terms: /\b(?:evidence|source range|source lines?|prove|citation|show code)\b/iu,
  },
  {
    operation: "search",
    terms: /\b(?:find|locate|search|where is|symbol|entrypoint|overview|onboard|architecture|domain)\b/iu,
  },
];

export function routeAgentIntent(request: string): AgentOperation {
  const normalized = request.trim();
  if (normalized.length === 0) return "native_fallback";
  return ROUTES.find((route) => route.terms.test(normalized))?.operation ?? "native_fallback";
}
