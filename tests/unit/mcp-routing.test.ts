import { describe, expect, it } from "vitest";
import { routeAgentIntent, type AgentOperation } from "../../src/mcp/routing.js";

describe("agent-native MCP intent routing", () => {
  it("selects the correct first operation for the declared routing corpus", () => {
    const fixtures: Array<[string, AgentOperation]> = [
      ["Find the checkout handler", "search"],
      ["Where is the MCP entrypoint?", "search"],
      ["Show the repository architecture", "search"],
      ["Which domain owns billing?", "search"],
      ["Onboard me to this repository", "search"],
      ["Add validation to checkout", "prepare_change"],
      ["Fix the stale cache bug", "prepare_change"],
      ["Plan a migration of the query store", "prepare_change"],
      ["Which affected tests should change?", "prepare_change"],
      ["Review the current diff", "prepare_change"],
      ["Trace the request lifecycle", "trace"],
      ["How does the route reach the database?", "trace"],
      ["Show the call chain from server to store", "trace"],
      ["Explain this execution journey", "trace"],
      ["Find a path from parse to persist", "trace"],
      ["Give me source evidence for this ID", "get_evidence"],
      ["Show code for this relationship", "get_evidence"],
      ["Prove this claim with source lines", "get_evidence"],
      ["Read the smallest source range", "get_evidence"],
      ["What is the weather tomorrow?", "native_fallback"],
    ];
    const correct = fixtures.filter(([request, expected]) => routeAgentIntent(request) === expected);
    expect(correct.length / fixtures.length).toBeGreaterThanOrEqual(0.95);
  });
});
