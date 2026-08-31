import { describe, expect, it } from "vitest";
import { loadSnapshot } from "../../src/git/snapshots.js";
import { irResult } from "../../src/mcp/ir-tools.js";

describe("canonical IR MCP result bounds", () => {
  it("rejects responses above the serialized byte ceiling", () => {
    expect(() => irResult({ payload: "x".repeat(2_100_000) })).toThrow(
      "reduce the requested limit",
    );
  });

  it("serializes one bounded representation for text content", () => {
    const result = irResult({ value: "bounded" });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("rejects dot-segment snapshot identifiers", async () => {
    await expect(loadSnapshot("unused", "..")).rejects.toThrow("Invalid snapshot ID");
    await expect(loadSnapshot("unused", ".")).rejects.toThrow("Invalid snapshot ID");
  });
});
