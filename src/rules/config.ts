import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hashing.js";
import { CodeAtlasError } from "../core/errors.js";
import type { ArchitectureRule, RuleSeverity } from "../ir/models.js";
import { DEFAULT_V2_CONFIG, type CodeAtlasV2Config, type DomainOverride } from "./types.js";

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if ((character === "\"" || character === "'") && line[index - 1] !== "\\") {
      quote = quote === character ? null : quote === null ? character : quote;
    }
    if (character === "#" && quote === null) return line.slice(0, index);
  }
  return line;
}

function scalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "") return {};
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => scalar(item));
  }
  return trimmed;
}

interface YamlLine { indent: number; text: string }

function parseBlock(lines: readonly YamlLine[], start: number, indent: number): [unknown, number] {
  const isArray = lines[start]?.text.startsWith("- ") ?? false;
  const output: unknown[] | Record<string, unknown> = isArray ? [] : {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(`Unexpected YAML indentation near: ${line.text}`);
    if (isArray) {
      if (!line.text.startsWith("- ")) break;
      const rest = line.text.slice(2).trim();
      if (rest === "") {
        const next = lines[index + 1];
        if (next === undefined || next.indent <= indent) {
          (output as unknown[]).push(null);
          index += 1;
        } else {
          const [child, nextIndex] = parseBlock(lines, index + 1, next.indent);
          (output as unknown[]).push(child);
          index = nextIndex;
        }
        continue;
      }
      const separator = rest.indexOf(":");
      if (separator > 0) {
        const item: Record<string, unknown> = {};
        const key = rest.slice(0, separator).trim();
        const value = rest.slice(separator + 1).trim();
        item[key] = scalar(value);
        index += 1;
        while (index < lines.length && lines[index]!.indent > indent) {
          const childLine = lines[index]!;
          if (childLine.text.startsWith("- ")) break;
          const childSeparator = childLine.text.indexOf(":");
          if (childSeparator < 1) throw new Error(`Invalid YAML mapping: ${childLine.text}`);
          const childKey = childLine.text.slice(0, childSeparator).trim();
          const childValue = childLine.text.slice(childSeparator + 1).trim();
          if (childValue !== "") {
            item[childKey] = scalar(childValue);
            index += 1;
          } else {
            const next = lines[index + 1];
            if (next === undefined || next.indent <= childLine.indent) {
              item[childKey] = {};
              index += 1;
            } else {
              const [child, nextIndex] = parseBlock(lines, index + 1, next.indent);
              item[childKey] = child;
              index = nextIndex;
            }
          }
        }
        (output as unknown[]).push(item);
      } else {
        (output as unknown[]).push(scalar(rest));
        index += 1;
      }
      continue;
    }
    const separator = line.text.indexOf(":");
    if (separator < 1) throw new Error(`Invalid YAML mapping: ${line.text}`);
    const key = line.text.slice(0, separator).trim();
    const value = line.text.slice(separator + 1).trim();
    if (value !== "") {
      (output as Record<string, unknown>)[key] = scalar(value);
      index += 1;
    } else {
      const next = lines[index + 1];
      if (next === undefined || next.indent <= indent) {
        (output as Record<string, unknown>)[key] = {};
        index += 1;
      } else {
        const [child, nextIndex] = parseBlock(lines, index + 1, next.indent);
        (output as Record<string, unknown>)[key] = child;
        index = nextIndex;
      }
    }
  }
  return [output, index];
}

export function parseCodeAtlasYaml(contents: string): unknown {
  const lines = contents.split(/\r?\n/u).map(stripComment).filter((line) => line.trim() !== "")
    .map((line): YamlLine => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
  if (lines.length === 0) return {};
  return parseBlock(lines, 0, lines[0]!.indent)[0];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function selector(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string",
  ));
}

function assertKnownKeys(value: Record<string, unknown>, pathName: string, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new CodeAtlasError(
      `Error: .codeatlas.yml contains unsupported ${pathName} field(s): ${unexpected.join(", ")}. ` +
      "Keep credentials and secrets in environment variables, never in .codeatlas.yml.",
    );
  }
}

function stringList(value: unknown, pathName: string, max = 500): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new CodeAtlasError(`Error: .codeatlas.yml ${pathName} must be a list of non-empty strings.`);
  }
  if (value.length > max) {
    throw new CodeAtlasError(`Error: .codeatlas.yml ${pathName} may contain at most ${max} entries.`);
  }
  return value.map((item) => (item as string).trim());
}

function boundedInteger(value: unknown, pathName: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new CodeAtlasError(
      `Error: .codeatlas.yml ${pathName} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value as number;
}

function environmentBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new CodeAtlasError(`Error: ${name} must be true/false or 1/0.`);
}

function environmentDepth(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return boundedInteger(parsed, name, fallback, 1, 100);
}

export function normalizeV2Config(value: unknown): CodeAtlasV2Config {
  const root = record(value);
  assertKnownKeys(root, "root", ["version", "index", "domains", "architecture", "analysis", "html", "ai"]);
  if (root.version !== undefined && root.version !== 1) {
    throw new CodeAtlasError("Error: .codeatlas.yml version must be 1.");
  }
  const index = record(root.index);
  assertKnownKeys(index, "index", ["exclude"]);
  const domains: Record<string, DomainOverride> = {};
  for (const [name, raw] of Object.entries(record(root.domains))) {
    const domain = record(raw);
    assertKnownKeys(domain, `domains.${name}`, ["include", "exclude"]);
    domains[name] = {
      include: stringList(domain.include, `domains.${name}.include`, 200),
      exclude: stringList(domain.exclude, `domains.${name}.exclude`, 200),
    };
  }
  const architecture = record(root.architecture);
  assertKnownKeys(architecture, "architecture", ["rules"]);
  if (architecture.rules !== undefined && !Array.isArray(architecture.rules)) {
    throw new CodeAtlasError("Error: .codeatlas.yml architecture.rules must be a list.");
  }
  const rules = (Array.isArray(architecture.rules) ? architecture.rules : []).map((raw, index): ArchitectureRule => {
    const rule = record(raw);
    assertKnownKeys(rule, `architecture.rules[${index}]`, ["id", "description", "severity", "source", "forbid"]);
    if (rule.severity !== undefined && !["info", "warning", "error"].includes(String(rule.severity))) {
      throw new CodeAtlasError(`Error: .codeatlas.yml architecture.rules[${index}].severity is invalid.`);
    }
    const severity = (rule.severity ?? "warning") as RuleSeverity;
    const id = typeof rule.id === "string" && rule.id.trim() !== "" ? rule.id.trim() : `rule-${index + 1}`;
    return {
      id,
      description: typeof rule.description === "string" ? rule.description : id,
      severity,
      source: selector(rule.source),
      forbid: record(rule.forbid),
    };
  });
  const analysis = record(root.analysis);
  assertKnownKeys(analysis, "analysis", ["max_call_depth", "max_impact_depth"]);
  const html = record(root.html);
  assertKnownKeys(html, "html", ["mode"]);
  if (html.mode !== undefined && html.mode !== "single-file" && html.mode !== "bundle") {
    throw new CodeAtlasError("Error: .codeatlas.yml html.mode must be single-file or bundle.");
  }
  const ai = record(root.ai);
  assertKnownKeys(ai, "ai", ["enabled"]);
  if (ai.enabled !== undefined && typeof ai.enabled !== "boolean") {
    throw new CodeAtlasError("Error: .codeatlas.yml ai.enabled must be true or false.");
  }
  return {
    version: DEFAULT_V2_CONFIG.version,
    index: { exclude: stringList(index.exclude, "index.exclude") },
    domains,
    architecture: { rules },
    analysis: {
      max_call_depth: boundedInteger(
        analysis.max_call_depth,
        "analysis.max_call_depth",
        DEFAULT_V2_CONFIG.analysis.max_call_depth,
        1,
        100,
      ),
      max_impact_depth: boundedInteger(
        analysis.max_impact_depth,
        "analysis.max_impact_depth",
        DEFAULT_V2_CONFIG.analysis.max_impact_depth,
        1,
        100,
      ),
    },
    html: { mode: html.mode === "bundle" ? "bundle" : "single-file" },
    ai: { enabled: ai.enabled === true },
  };
}

export async function loadV2Config(repositoryRoot: string): Promise<CodeAtlasV2Config> {
  let config: CodeAtlasV2Config;
  try {
    const contents = await readFile(path.join(repositoryRoot, ".codeatlas.yml"), "utf8");
    config = normalizeV2Config(parseCodeAtlasYaml(contents));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") config = DEFAULT_V2_CONFIG;
    else throw error;
  }
  const htmlMode = process.env.CODEATLAS_HTML_MODE;
  if (htmlMode !== undefined && htmlMode !== "single-file" && htmlMode !== "bundle") {
    throw new CodeAtlasError("Error: CODEATLAS_HTML_MODE must be single-file or bundle.");
  }
  const aiEnabled = environmentBoolean(process.env.CODEATLAS_AI_ENABLED, "CODEATLAS_AI_ENABLED");
  return {
    ...config,
    analysis: {
      max_call_depth: environmentDepth(
        process.env.CODEATLAS_MAX_CALL_DEPTH,
        "CODEATLAS_MAX_CALL_DEPTH",
        config.analysis.max_call_depth,
      ),
      max_impact_depth: environmentDepth(
        process.env.CODEATLAS_MAX_IMPACT_DEPTH,
        "CODEATLAS_MAX_IMPACT_DEPTH",
        config.analysis.max_impact_depth,
      ),
    },
    html: { mode: htmlMode ?? config.html.mode },
    ai: { enabled: aiEnabled ?? config.ai.enabled },
  };
}

export function v2ConfigFingerprint(config: CodeAtlasV2Config): string {
  return sha256(JSON.stringify(config));
}
