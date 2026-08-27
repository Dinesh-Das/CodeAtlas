import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/cli/init.js";
import { getStatus } from "../../src/cli/status.js";
import { workspacePaths } from "../../src/core/workspace.js";
import { answerPacketSchema } from "../../src/mcp/schemas.js";
import { openDatabase } from "../../src/storage/database.js";
import { createTestRepository, type TestRepository } from "../helpers/repository.js";

const repositories: TestRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.remove()));
});

describe("MCP stdio contract", () => {
  it(
    "starts the compiled server and validates every required tool response",
    async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      await repository.write("src/index.ts", "export function ready(): boolean { return true; }\n");
      await repository.git("add", ".");
      await repository.git("commit", "-m", "mcp fixture");
      await initializeRepository(repository.root);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("dist", "cli", "index.js"), "mcp", repository.root],
        cwd: repository.root,
        stderr: "pipe",
      });
      const client = new Client({ name: "codeatlas-contract-tests", version: "1.0.0" });
      await client.connect(transport);
      try {
        const listed = await client.listTools();
        const expectedNames = [
          "codeatlas_status",
          "codeatlas_overview",
          "codeatlas_search",
          "codeatlas_get_node",
          "codeatlas_explain_feature",
          "codeatlas_trace",
          "codeatlas_impact",
          "codeatlas_dependencies",
          "codeatlas_source",
          "codeatlas_health",
        ];
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual(expectedNames.sort());
        const trace = listed.tools.find((tool) => tool.name === "codeatlas_trace");
        expect(trace?.inputSchema).toHaveProperty("properties.start");
        expect(trace?.inputSchema).not.toHaveProperty("properties.from");

        const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
          { name: "codeatlas_status", arguments: {} },
          { name: "codeatlas_overview", arguments: {} },
          { name: "codeatlas_search", arguments: { query: "ready" } },
          { name: "codeatlas_get_node", arguments: { node_id: "fixture-node" } },
          { name: "codeatlas_explain_feature", arguments: { feature: "checkout" } },
          { name: "codeatlas_trace", arguments: { start: "ready", max_depth: 4 } },
          { name: "codeatlas_impact", arguments: { target: "ready" } },
          {
            name: "codeatlas_dependencies",
            arguments: { target: "ready", direction: "both" },
          },
          { name: "codeatlas_source", arguments: { node_id: "fixture-node" } },
          { name: "codeatlas_health", arguments: {} },
        ];
        for (const call of calls) {
          const result = await client.callTool(call);
          expect(result.isError).not.toBe(true);
          const packet = answerPacketSchema.parse(result.structuredContent);
          expect(packet).toMatchObject({
            answer_context: { tool: call.name },
            source_snippets: [],
            pagination: { cursor: null, has_more: false },
          });
          if (call.name === "codeatlas_overview" || call.name === "codeatlas_health") {
            expect(packet.facts.length).toBeGreaterThan(0);
          } else {
            expect(packet.facts).toEqual([]);
            expect(packet.relationships).toEqual([]);
          }
        }

        const legacyTrace = await client.callTool({
          name: "codeatlas_trace",
          arguments: { from: "ready" },
        });
        expect(legacyTrace.isError).toBe(true);
        const excessivePage = await client.callTool({
          name: "codeatlas_search",
          arguments: { query: "ready", limit: 201 },
        });
        expect(excessivePage.isError).toBe(true);

        await repository.write("src/fresh.ts", "export const fresh = true;\n");
        await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: false });
        const refreshed = await client.callTool({ name: "codeatlas_status", arguments: {} });
        expect(answerPacketSchema.parse(refreshed.structuredContent).freshness).toMatchObject({
          working_tree_checked: true,
        });
        await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: true });
      } finally {
        await client.close();
      }
    },
    30_000,
  );

  it(
    "refreshes changed dependencies and removes obsolete relationships before responding",
    async () => {
      const repository = await createTestRepository();
      repositories.push(repository);
      await repository.write(
        "src/service.ts",
        "export function oldOperation(): boolean { return true; }\n",
      );
      await repository.write(
        "src/caller.ts",
        'import { oldOperation } from "./service.js";\nexport function invoke(): boolean { return oldOperation(); }\n',
      );
      await repository.git("add", ".");
      await repository.git("commit", "-m", "freshness dependency fixture");
      await initializeRepository(repository.root);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("dist", "cli", "index.js"), "mcp", repository.root],
        cwd: repository.root,
        stderr: "pipe",
      });
      const client = new Client({ name: "codeatlas-freshness-tests", version: "1.0.0" });
      await client.connect(transport);
      try {
        await repository.write(
          "src/service.ts",
          "export function newOperation(): boolean { return false; }\n",
        );
        await expect(getStatus(repository.root)).resolves.toMatchObject({ synchronized: false });
        const response = await client.callTool({ name: "codeatlas_status", arguments: {} });
        const packet = answerPacketSchema.parse(response.structuredContent);
        const status = await getStatus(repository.root);
        expect(status.synchronized).toBe(true);
        expect(packet.freshness.fingerprint).toBe(status.currentFingerprint);

        const database = openDatabase(workspacePaths(repository.root).database, {
          readonly: true,
        });
        try {
          expect(
            database.prepare("SELECT count(*) FROM nodes WHERE qualified_name = 'oldOperation'").pluck().get(),
          ).toBe(0);
          expect(
            database.prepare("SELECT count(*) FROM nodes WHERE qualified_name = 'newOperation'").pluck().get(),
          ).toBe(1);
          expect(
            database
              .prepare(
                `SELECT count(*) FROM edges
                 JOIN nodes target ON target.id = edges.target_node_id
                 WHERE edges.edge_type = 'CALLS' AND target.qualified_name = 'oldOperation'`,
              )
              .pluck()
              .get(),
          ).toBe(0);
        } finally {
          database.close();
        }
      } finally {
        await client.close();
      }
    },
    30_000,
  );
});
