import { CodeAtlasError } from "../core/errors.js";
import type { AtlasEvidence } from "../ir/models.js";
import {
  serializeChangeContext,
  type ChangeContext,
  type ChangeContextEvidence,
  type ChangeContextFormat,
} from "./packet.js";

export interface ContextBudgetInput {
  requested: number;
  format: ChangeContextFormat;
  envelopeReserve: number;
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

function contextEvidence(evidence: AtlasEvidence): ChangeContextEvidence {
  return {
    id: evidence.id,
    file: evidence.file,
    start_line: evidence.start_line,
    start_column: evidence.start_column,
    end_line: evidence.end_line,
    end_column: evidence.end_column,
    kind: evidence.kind,
    excerpt: evidence.excerpt,
    excerpt_status: evidence.excerpt_status,
    trust: "untrusted_repository_content",
  };
}

function overlaps(
  left: Pick<AtlasEvidence, "file" | "start_line" | "end_line">,
  right: Pick<AtlasEvidence, "file" | "start_line" | "end_line">,
): boolean {
  return left.file === right.file && left.start_line <= right.end_line && right.start_line <= left.end_line;
}

function canonicalizeEvidence(
  item: unknown,
  evidenceById: ReadonlyMap<string, AtlasEvidence>,
  selected: readonly ChangeContextEvidence[],
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
        const existing = [...selected, ...additions].find((selectedEvidence) =>
          selectedEvidence.id === id || overlaps(selectedEvidence, evidence)
        );
        const canonicalId = existing?.id ?? id;
        if (!canonicalIds.includes(canonicalId)) canonicalIds.push(canonicalId);
        if (existing === undefined) additions.push(contextEvidence(evidence));
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
): boolean {
  const collection = packet[key] as ChangeContext[K][number][];
  const normalized = canonicalizeEvidence(item, evidenceById, packet.evidence);
  const additions = normalized.additions;
  collection.push(normalized.item as ChangeContext[K][number]);
  packet.evidence.push(...additions);
  const used = updateUsed(packet);
  if (used <= packet.budget.requested) return true;
  collection.pop();
  packet.evidence.splice(packet.evidence.length - additions.length, additions.length);
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
    continuation: "Use exact candidate IDs with get_symbol, analyze_impact, and get_evidence for omitted detail.",
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
    ["ambiguous_target", "insufficient_task_specificity", "unsupported_coverage"].includes(gap.code)
  );
  const resolutionGaps = collections.gaps.filter((gap) => !priorityGaps.includes(gap));
  const priorityChecklist = [
    collections.verification_checklist.find((item) => item.kind === "edit_location"),
    collections.verification_checklist.find((item) => item.kind === "command"),
  ].filter((item): item is ChangeContext["verification_checklist"][number] => item !== undefined);
  const ordered: Array<[keyof typeof collections, readonly unknown[]]> = [
    ["change_candidates", collections.change_candidates.slice(0, 1)],
    ["edit_locations", collections.edit_locations.slice(0, 2)],
    ["gaps", priorityGaps],
    ["relevant_tests", collections.relevant_tests.slice(0, 1)],
    ["verification_checklist", priorityChecklist],
    ["validation_commands", collections.validation_commands],
    ["verified_paths", collections.verified_paths.slice(0, 2)],
    ["change_candidates", collections.change_candidates.slice(1, 4).map(compactCandidate)],
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
      if (tryAdd(packet, key, item as never, evidenceById)) continue;
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
