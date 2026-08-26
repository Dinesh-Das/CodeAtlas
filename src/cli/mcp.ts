import { CodeAtlasError } from "../core/errors.js";

export async function startMcpServer(): Promise<never> {
  throw new CodeAtlasError(
    "The MCP server is scheduled for Phase 3 after evidence-bearing parser and relationship contracts exist.",
  );
}
