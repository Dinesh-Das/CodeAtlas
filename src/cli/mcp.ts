import { startCodeAtlasMcpServer } from "../mcp/server.js";

export async function startMcpServer(targetPath = process.cwd()): Promise<void> {
  await startCodeAtlasMcpServer(targetPath);
}
