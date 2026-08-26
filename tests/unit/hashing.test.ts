import { describe, expect, it } from "vitest";
import { hashSortedEntries, sha256 } from "../../src/core/hashing.js";
import { createEdgeId, createNodeId } from "../../src/graph/ids.js";

describe("hashing and graph IDs", () => {
  it("computes stable SHA-256 digests", () => {
    expect(sha256("codeatlas")).toBe(
      "eb6d94e96dde9e6d6da8498098d568a6c7f49a59962c50fef2161de13d957af8",
    );
  });

  it("sorts fingerprint entries before hashing", () => {
    expect(hashSortedEntries(["b:2", "a:1"])).toBe(hashSortedEntries(["a:1", "b:2"]));
  });

  it("creates deterministic, identity-sensitive graph IDs", () => {
    const first = createNodeId("repo", "function", "src/payments.ts", "charge");
    expect(createNodeId("repo", "function", "src/payments.ts", "charge")).toBe(first);
    expect(createNodeId("repo", "function", "src/payments.ts", "refund")).not.toBe(first);

    const edge = createEdgeId("repo", "CALLS", first, "target", "src/payments.ts", 10);
    expect(createEdgeId("repo", "CALLS", first, "target", "src/payments.ts", 10)).toBe(edge);
  });
});
