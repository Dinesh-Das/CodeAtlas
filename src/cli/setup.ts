import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodeAtlasError } from "../core/errors.js";
import { workspaceExists } from "../core/workspace.js";
import { detectRepository } from "../git/repository.js";

const execFile = promisify(execFileCallback);

export const SETUP_TARGETS = ["codex", "claude", "cursor", "antigravity"] as const;
export type SetupTarget = (typeof SETUP_TARGETS)[number];

export interface SetupResult {
  repositoryRoot: string;
  targets: Array<{
    target: SetupTarget;
    status: "configured" | "already_configured" | "planned";
    destination: string;
  }>;
}

async function optionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await execFile(command, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function detectSetupTargets(): Promise<SetupTarget[]> {
  const home = os.homedir();
  const availability = await Promise.all([
    commandAvailable("codex"),
    commandAvailable("claude"),
    commandAvailable("cursor"),
    commandAvailable("agy"),
  ]);
  const detected = new Set<SetupTarget>();
  if (availability[0]) detected.add("codex");
  if (availability[1]) detected.add("claude");
  if (availability[2] || await optionalText(path.join(home, ".cursor", "mcp.json")) !== "") {
    detected.add("cursor");
  }
  if (
    availability[3] ||
    await optionalText(path.join(home, ".gemini", "config", "mcp_config.json")) !== ""
  ) {
    detected.add("antigravity");
  }
  return SETUP_TARGETS.filter((target) => detected.has(target));
}

function jsonObject(value: unknown, filePath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodeAtlasError(`Error: ${filePath} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function mergeJsonServer(
  filePath: string,
  server: Record<string, unknown>,
  dryRun: boolean,
): Promise<"configured" | "already_configured" | "planned"> {
  const currentText = await optionalText(filePath);
  let current: Record<string, unknown> = {};
  if (currentText.trim() !== "") {
    try {
      current = jsonObject(JSON.parse(currentText) as unknown, filePath);
    } catch (error) {
      if (error instanceof CodeAtlasError) throw error;
      throw new CodeAtlasError(`Error: ${filePath} contains invalid JSON.`, { cause: error });
    }
  }
  const servers = current.mcpServers === undefined
    ? {}
    : jsonObject(current.mcpServers, `${filePath}#mcpServers`);
  const existing = servers.codeatlas;
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(server)) return "already_configured";
    throw new CodeAtlasError(
      `Error: ${filePath} already defines an MCP server named codeatlas with different settings.`,
    );
  }
  if (dryRun) return "planned";
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ ...current, mcpServers: { ...servers, codeatlas: server } }, null, 2)}\n`,
    "utf8",
  );
  return "configured";
}

async function addCliServer(
  command: "codex" | "claude",
  serverName: string,
  repositoryRoot: string,
  dryRun: boolean,
): Promise<"configured" | "already_configured" | "planned"> {
  const destination = command === "codex"
    ? `${path.join(os.homedir(), ".codex", "config.toml")}#mcp_servers.${serverName}`
    : `${path.join(os.homedir(), ".claude.json")}#projects[${repositoryRoot}].mcpServers.codeatlas`;
  if (dryRun) return "planned";
  if (!(await commandAvailable(command))) {
    throw new CodeAtlasError(
      `Error: ${command} is not available on PATH; rerun setup without that target or install it first.`,
    );
  }
  const getArgs = ["mcp", "get", serverName];
  try {
    await execFile(command, getArgs, {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    return "already_configured";
  } catch {
    // A missing entry is the normal first-run condition.
  }
  const addArgs = command === "codex"
    ? ["mcp", "add", serverName, "--", "codeatlas", "mcp", repositoryRoot]
    : [
        "mcp", "add", "--transport", "stdio", "--scope", "local", serverName,
        "--", "codeatlas", "mcp", repositoryRoot,
      ];
  try {
    await execFile(command, addArgs, {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    return "configured";
  } catch (error) {
    throw new CodeAtlasError(`Error: ${command} could not configure ${destination}.`, {
      cause: error,
    });
  }
}

export async function setupRepository(
  startPath = process.cwd(),
  options: { targets?: readonly SetupTarget[]; dryRun?: boolean } = {},
): Promise<SetupResult> {
  const repository = await detectRepository(startPath);
  if (!(await workspaceExists(repository.root))) {
    throw new CodeAtlasError("Error: CodeAtlas is not initialized. Run `codeatlas init` first.");
  }
  const targets = options.targets === undefined
    ? await detectSetupTargets()
    : [...new Set(options.targets)];
  if (targets.length === 0) {
    throw new CodeAtlasError(
      "Error: no supported coding agent was detected. Use --target codex,claude,cursor,antigravity.",
    );
  }
  const dryRun = options.dryRun === true;
  const results: SetupResult["targets"] = [];
  for (const target of targets) {
    if (target === "codex") {
      const serverName = `codeatlas-${repository.name.replace(/[^A-Za-z0-9_-]+/gu, "-")}-${repository.id.slice(0, 8)}`;
      results.push({
        target,
        status: await addCliServer("codex", serverName, repository.root, dryRun),
        destination: `${path.join(os.homedir(), ".codex", "config.toml")}#mcp_servers.${serverName}`,
      });
      continue;
    }
    if (target === "claude") {
      results.push({
        target,
        status: await addCliServer("claude", "codeatlas", repository.root, dryRun),
        destination: `${path.join(os.homedir(), ".claude.json")} (local project scope)`,
      });
      continue;
    }
    const filePath = target === "cursor"
      ? path.join(repository.root, ".cursor", "mcp.json")
      : path.join(repository.root, ".agents", "mcp_config.json");
    const server = target === "cursor"
      ? { type: "stdio", command: "codeatlas", args: ["mcp", "${workspaceFolder}"] }
      : { command: "codeatlas", args: ["mcp", repository.root], cwd: repository.root };
    results.push({
      target,
      status: await mergeJsonServer(filePath, server, dryRun),
      destination: filePath,
    });
  }
  return { repositoryRoot: repository.root, targets: results };
}

export function parseSetupTargets(value: string): SetupTarget[] {
  const values = value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const invalid = values.filter((entry) => !SETUP_TARGETS.includes(entry as SetupTarget));
  if (invalid.length > 0) {
    throw new CodeAtlasError(
      `Error: unsupported setup target(s): ${invalid.join(", ")}. Expected ${SETUP_TARGETS.join(", ")}.`,
    );
  }
  return values as SetupTarget[];
}

export function formatSetupResult(result: SetupResult): string {
  return [
    "CodeAtlas MCP setup",
    "",
    ...result.targets.map((entry) => {
      const marker = entry.status === "already_configured" ? "=" : entry.status === "planned" ? ">" : "+";
      return `[${marker}] ${entry.target}: ${entry.status.replaceAll("_", " ")} (${entry.destination})`;
    }),
    "",
    result.targets.every((entry) => entry.status === "planned")
      ? "Dry run only; no configuration was changed."
      : "Restart or reload the configured coding agents, then ask for a CodeAtlas overview.",
  ].join("\n");
}
