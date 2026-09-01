import path from "node:path";
import type { AtlasSymbol } from "../ir/models.js";

export const ARCHITECTURAL_SCOPES = [
  "production",
  "test",
  "fixture",
  "example",
  "generated",
  "documentation",
  "configuration",
  "unknown",
] as const;

export type ArchitecturalScope = (typeof ARCHITECTURAL_SCOPES)[number];

const SEGMENT = "(?:^|/)";

export function classifyArchitecturalScope(filePath: string | null): ArchitecturalScope {
  if (filePath === null || filePath.trim() === "") return "unknown";
  const normalized = filePath.replaceAll("\\", "/").toLocaleLowerCase();
  if (new RegExp(`${SEGMENT}(?:tests?|__tests__)/fixtures?(?:/|$)`, "u").test(normalized) ||
      new RegExp(`${SEGMENT}(?:fixtures?|__fixtures__)(?:/|$)`, "u").test(normalized)) {
    return "fixture";
  }
  if (new RegExp(`${SEGMENT}(?:examples?|samples?|demos?)(?:/|$)`, "u").test(normalized)) {
    return "example";
  }
  if (new RegExp(`${SEGMENT}(?:tests?|__tests__|specs?)(?:/|$)`, "u").test(normalized) ||
      /\.(?:spec|test)\.[^/]+$/u.test(normalized)) {
    return "test";
  }
  if (new RegExp(`${SEGMENT}(?:dist|build|coverage|generated|__generated__|vendor|node_modules)(?:/|$)`, "u").test(normalized)) {
    return "generated";
  }
  if (new RegExp(`${SEGMENT}(?:docs?|documentation)(?:/|$)`, "u").test(normalized) ||
      /\.(?:md|mdx|rst|adoc)$/u.test(normalized)) {
    return "documentation";
  }
  const extension = path.posix.extname(normalized);
  if ([".json", ".jsonc", ".yaml", ".yml", ".toml"].includes(extension) ||
      new RegExp(`${SEGMENT}(?:\\.github|config)(?:/|$)`, "u").test(normalized)) {
    return "configuration";
  }
  return "production";
}

export function symbolArchitecturalScope(symbol: Pick<AtlasSymbol, "file" | "scope">): ArchitecturalScope {
  return symbol.scope ?? classifyArchitecturalScope(symbol.file);
}

export function isPrimaryArchitectureScope(scope: ArchitecturalScope): boolean {
  return scope === "production" || scope === "configuration";
}

export function isPrimaryArchitectureSymbol(symbol: AtlasSymbol): boolean {
  return isPrimaryArchitectureScope(symbolArchitecturalScope(symbol));
}

export function isArchitecturalEntrypoint(symbol: AtlasSymbol): boolean {
  if (!isPrimaryArchitectureSymbol(symbol)) return false;
  if (symbol.kind === "endpoint") return true;
  if (symbol.kind !== "function" && symbol.kind !== "method") return false;
  const file = symbol.file?.replaceAll("\\", "/").toLocaleLowerCase() ?? "";
  const name = symbol.name.toLocaleLowerCase();
  if (name === "main" || name === "bootstrap") return true;
  if (/(?:^|\/)(?:cli|bin)(?:\/|$)/u.test(file) && name === "createprogram") return true;
  if (/(?:^|\/)(?:mcp\/server|server|app|index)\.[^/]+$/u.test(file) &&
      /^(?:start|create).*(?:server|app)$/u.test(name)) return true;
  return false;
}
