import type { FreshContext } from "./freshness.js";
import { answerPacketSchema, type AnswerPacket } from "./schemas.js";

export function emptyAnswerPacket(
  tool: string,
  topic: string,
  context: FreshContext,
): AnswerPacket {
  return answerPacketSchema.parse({
    answer_context: { topic, tool },
    facts: [],
    relationships: [],
    source_snippets: [],
    uncertainties: [
      {
        description: "This query is registered, but its graph-backed result set is not implemented yet.",
        reason: "insufficient_evidence",
        candidates: [],
      },
    ],
    freshness: {
      fingerprint: context.status.currentFingerprint,
      head_commit: context.status.headCommit,
      working_tree_checked: true,
      checked_at: context.checkedAt,
    },
    pagination: { cursor: null, has_more: false },
  });
}
