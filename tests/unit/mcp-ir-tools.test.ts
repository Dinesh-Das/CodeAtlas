import { describe, expect, it } from "vitest";
import { loadSnapshot } from "../../src/git/snapshots.js";
import { irResult } from "../../src/mcp/ir-tools.js";
import { canonicalResultSchema } from "../../src/mcp/schemas.js";

describe("canonical IR MCP result bounds", () => {
  it("rejects responses above the serialized byte ceiling", () => {
    expect(() => irResult({ payload: "x".repeat(2_100_000) })).toThrow(
      "reduce the requested limit",
    );
  });

  it("serializes one bounded representation for text content", () => {
    const result = irResult({ value: "bounded" });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(canonicalResultSchema.parse(result.structuredContent)).toMatchObject({
      derivation: "canonical_ir",
      status: "ok",
      error: null,
      codeatlas: {
        schema_version: null,
        snapshot_ids: [],
        fingerprint: null,
        generations: null,
        freshness: null,
        content_trust: {
          indexing: "local_only",
          repository_content: "untrusted",
          answer_policy: "evidence_only",
        },
        coverage: { bounded: false, truncated: false, limitations: [] },
        uncertainty: {
          inferred_facts: 0,
          unresolved_references: 0,
          ambiguous_references: 0,
          dynamic_references: 0,
          conditional_relationships: 0,
        },
      },
    });
  });

  it("rejects dot-segment snapshot identifiers", async () => {
    await expect(loadSnapshot("unused", "..")).rejects.toThrow("Invalid snapshot ID");
    await expect(loadSnapshot("unused", ".")).rejects.toThrow("Invalid snapshot ID");
  });
});
