import { CodeAtlasError } from "../core/errors.js";
import type { AtlasEvidence } from "../ir/models.js";
import {
  serializeChangeContext,
  type ChangeContext,
  type ChangeContextEvidence,
  type ChangeContextFormat,
  type ContextEvidenceMode,
  type ChangeContextPathSymbol,
} from "./packet.js";

export interface ContextBudgetInput {
  requested: number;
  format: ChangeContextFormat;
  envelopeReserve: number;
  pathSymbols?: ReadonlyMap<string, ChangeContextPathSymbol>;
}

export function estimatedContextBytes(serialized: string): number {
  return Buffer.byteLength(serialized, "utf8");
}

function updateUsed(packet: ChangeContext): number {
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const used = estimatedContextBytes(serializeChangeContext(packet, packet.budget.format)) +
      packet.budget.envelope_reserved;
    packet.budget.used = used;
    if (used === previous) return used;
    previous = used;
  }
  return packet.budget.used;
}

function contextEvidence(evidence: AtlasEvidence, mode?: ContextEvidenceMode): ChangeContextEvidence {
  return {
    id: evidence.id,
    file: evidence.file,
    start_line: evidence.start_line,
    start_column: evidence.start_column,
    end_line: evidence.end_line,
    end_column: evidence.end_column,
    kind: evidence.kind,
    excerpt: mode === "references" ? null : evidence.excerpt,
    excerpt_status: evidence.excerpt_status,
    trust: "untrusted_repository_content",
    ...(mode !== "references" ? {} : {
      deferred: true as const,
      file_content_hash: evidence.file_content_hash,
      range_content_hash: evidence.range_content_hash,
    }),
  };
}

function canonicalizeEvidence(
  item: unknown,
  evidenceById: ReadonlyMap<string, AtlasEvidence>,
  selected: readonly ChangeContextEvidence[],
  mode?: ContextEvidenceMode,
): { item: unknown; additions: ChangeContextEvidence[] } {
  const additions: ChangeContextEvidence[] = [];
  const value = structuredClone(item);
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (Array.isArray(record.evidence_ids)) {
      const canonicalIds: string[] = [];
      for (const id of record.evidence_ids) {
        if (typeof id !== "string") continue;
        const evidence = evidenceById.get(id);
        if (evidence === undefined) continue;
        const existing = [...selected, ...additions].find((selectedEvidence) => selectedEvidence.id === id);
        if (!canonicalIds.includes(id)) canonicalIds.push(id);
        if (existing === undefined) additions.push(contextEvidence(evidence, mode));
      }
      record.evidence_ids = canonicalIds;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return { item: value, additions };
}

function tryAdd<K extends keyof Pick<
  ChangeContext,
  "change_candidates" | "verified_paths" | "potential_paths" | "relevant_flows" |
  "affected_contracts" | "relevant_tests" | "constraints" | "edit_locations" |
  "invariants" | "validation_commands" | "verification_checklist" | "gaps"
>>(
  packet: ChangeContext,
  key: K,
  item: ChangeContext[K][number],
  evidenceById: ReadonlyMap<string, AtlasEvidence>,
  pathSymbols?: ReadonlyMap<string, ChangeContextPathSymbol>,
): boolean {
  const collection = packet[key] as ChangeContext[K][number][];
  const normalized = canonicalizeEvidence(item, evidenceById, packet.evidence, packet.evidence_mode);
  const additions = normalized.additions;
  const previousPathSymbols = packet.path_symbols?.length ?? 0;
  if (packet.path_symbols !== undefined && pathSymbols !== undefined &&
      (key === "verified_paths" || key === "potential_paths" || key === "relevant_flows")) {
    const known = new Set([
      ...packet.path_symbols.map((symbol) => symbol.id),
      ...packet.change_candidates.map((candidate) => candidate.symbol.id),
      ...packet.relevant_tests.map((test) => test.symbol.id),
      ...packet.affected_contracts.map((contract) => contract.symbol.id),
    ]);
    for (const id of (item as ChangeContext["verified_paths"][number]).symbol_ids) {
      const symbol = pathSymbols.get(id);
      if (symbol === undefined || known.has(id)) continue;
      packet.path_symbols.push(symbol);
      known.add(id);
    }
  }
  collection.push(normalized.item as ChangeContext[K][number]);
  packet.evidence.push(...additions);
  const used = updateUsed(packet);
  if (used <= packet.budget.requested) return true;
  collection.pop();
  packet.evidence.splice(packet.evidence.length - additions.length, additions.length);
  packet.path_symbols?.splice(previousPathSymbols);
  updateUsed(packet);
  return false;
}

function compactCandidate(candidate: ChangeContext["change_candidates"][number]) {
  return {
    ...candidate,
    retrieval_reasons: candidate.retrieval_reasons.slice(0, 2),
    recommendation: {
      ...candidate.recommendation,
      rationale: "Highest-ranked source-backed starting point.",
    },
    supporting_paths: [],
    evidence_ids: candidate.symbol.evidence_ids,
  };
}

export function fitChangeContextToBudget(
  base: Omit<ChangeContext, "change_candidates" | "verified_paths" | "potential_paths" |
    "relevant_flows" | "affected_contracts" | "relevant_tests" | "constraints" |
    "edit_locations" | "invariants" | "validation_commands" | "verification_checklist" |
    "evidence" | "gaps" | "budget" | "continuation">,
  collections: Pick<ChangeContext, "change_candidates" | "verified_paths" | "potential_paths" |
    "relevant_flows" | "affected_contracts" | "relevant_tests" | "constraints" |
    "edit_locations" | "invariants" | "validation_commands" | "verification_checklist" | "gaps">,
  evidence: readonly AtlasEvidence[],
  budget: ContextBudgetInput,
): ChangeContext {
  const packet: ChangeContext = {
    ...base,
    ...(budget.format === "compact" ? { path_symbols: [] } : {}),
    change_candidates: [],
    edit_locations: [],
    verified_paths: [],
    potential_paths: [],
    relevant_flows: [],
    affected_contracts: [],
    relevant_tests: [],
    constraints: [],
    invariants: [],
    validation_commands: [],
    verification_checklist: [],
    evidence: [],
    gaps: [],
    budget: {
      requested: budget.requested,
      used: 0,
      unit: "utf8_bytes_upper_bound",
      estimator: "utf8-bytes-upper-bound/v1",
      envelope_reserved: budget.envelopeReserve,
      format: budget.format,
    },
    continuation: budget.format === "compact"
      ? "Expand aliases, then read codeatlas://symbol/{id}, trace between full IDs, or use get_evidence for source proof."
      : "Read candidate resource_links, then use trace between stable IDs and get_evidence for source proof.",
  };
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  if (updateUsed(packet) > budget.requested) {
    throw new CodeAtlasError(
      `The ${budget.requested}-byte context budget is too small for the task, coverage, and continuation envelope.`,
      {
        code: "budget_too_small",
        recoverable: true,
        nextActions: ["Increase the byte budget or shorten the task description."],
        details: { requested: budget.requested, minimum: packet.budget.used },
      },
    );
  }
  let omitted = 0;
  const priorityGaps = collections.gaps.filter((gap) =>
    ["ambiguous_target", "insufficient_task_specificity", "unsupported_coverage", "validation_unavailable"]
      .includes(gap.code)
  );
  const resolutionGaps = collections.gaps.filter((gap) => !priorityGaps.includes(gap));
  const firstCommand = collections.validation_commands[0];
  const editChecklist = collections.verification_checklist.find((item) => item.kind === "edit_location");
  const rawCommandChecklist = collections.verification_checklist.find((item) => item.kind === "command");
  const commandChecklist = rawCommandChecklist === undefined || firstCommand === undefined
    ? undefined
    : {
        ...rawCommandChecklist,
        instruction: "Run the included validation command and record its result.",
        target_ids: [firstCommand.id],
        evidence_ids: firstCommand.evidence_ids,
      };
  const priorityChecklist = [editChecklist, commandChecklist]
    .filter((item): item is ChangeContext["verification_checklist"][number] => item !== undefined);
  // A compact brief should establish the cross-file boundary before elaborating one candidate.
  // Candidates are already diversified by file by the planner.
  const compact = budget.format === "compact";
  const initialCandidates = compact ? 2 : 1;
  const ordered: Array<[keyof typeof collections, readonly unknown[]]> = [
    ["change_candidates", collections.change_candidates.slice(0, initialCandidates).map(compactCandidate)],
    ["edit_locations", collections.edit_locations.slice(0, 1)],
    ["validation_commands", collections.validation_commands.slice(0, 1)],
    ["gaps", priorityGaps],
    ["relevant_tests", collections.relevant_tests.slice(0, 1)],
    ["change_candidates", compact ? collections.change_candidates.slice(2, 3).map(compactCandidate) : []],
    ["verification_checklist", priorityChecklist],
    ["verified_paths", collections.verified_paths.slice(0, 1)],
    ["edit_locations", collections.edit_locations.slice(1, 2)],
    ["validation_commands", collections.validation_commands.slice(1)],
    ["verified_paths", collections.verified_paths.slice(1, 2)],
    ["change_candidates", collections.change_candidates.slice(compact ? 3 : 1, 4).map(compactCandidate)],
    ["affected_contracts", collections.affected_contracts],
    ["invariants", collections.invariants],
    ["constraints", collections.constraints],
    ["relevant_flows", collections.relevant_flows],
    ["verified_paths", collections.verified_paths.slice(2)],
    ["relevant_tests", collections.relevant_tests.slice(1)],
    ["gaps", resolutionGaps],
    ["potential_paths", collections.potential_paths],
    ["verification_checklist", collections.verification_checklist.filter((item) =>
      item.kind !== "command" && item.kind !== "edit_location"
    )],
    ["change_candidates", collections.change_candidates.slice(4).map(compactCandidate)],
  ];
  for (const [key, items] of ordered) {
    for (const item of items) {
      if (tryAdd(packet, key, item as never, evidenceById, budget.pathSymbols)) continue;
      if (key === "change_candidates") {
        const candidate = item as ChangeContext["change_candidates"][number];
        const compact = compactCandidate(candidate);
        if (tryAdd(packet, "change_candidates", compact, evidenceById)) {
          omitted += 1;
          continue;
        }
      }
      omitted += 1;
    }
  }
  if (omitted === 0) packet.continuation = null;
  else {
    const gap = collections.gaps.find((item) => item.code === "budget_truncated") ?? {
      code: "budget_truncated" as const,
      message: `${omitted} lower-ranked context items were omitted to honor the requested budget.`,
      target: null,
      candidate_ids: packet.change_candidates.map((candidate) => candidate.symbol.id),
      evidence_ids: [],
    };
    if (!packet.gaps.some((item) => item.code === "budget_truncated")) {
      tryAdd(packet, "gaps", gap, evidenceById);
    }
  }
  updateUsed(packet);
  return packet;
}
