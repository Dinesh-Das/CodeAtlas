import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hashing.js";
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

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function selector(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string",
  ));
}

export function normalizeV2Config(value: unknown): CodeAtlasV2Config {
  const root = record(value);
  const domains: Record<string, DomainOverride> = {};
  for (const [name, raw] of Object.entries(record(root.domains))) {
    const domain = record(raw);
    domains[name] = { include: strings(domain.include), exclude: strings(domain.exclude) };
  }
  const architecture = record(root.architecture);
  const rules = (Array.isArray(architecture.rules) ? architecture.rules : []).map((raw, index): ArchitectureRule => {
    const rule = record(raw);
    const severity = ["info", "warning", "error"].includes(String(rule.severity))
      ? rule.severity as RuleSeverity
      : "warning";
    const id = typeof rule.id === "string" && rule.id !== "" ? rule.id : `rule-${index + 1}`;
    return {
      id,
      description: typeof rule.description === "string" ? rule.description : id,
      severity,
      source: selector(rule.source),
      forbid: record(rule.forbid),
    };
  });
  const analysis = record(root.analysis);
  const html = record(root.html);
  const ai = record(root.ai);
  return {
    version: typeof root.version === "number" ? root.version : DEFAULT_V2_CONFIG.version,
    domains,
    architecture: { rules },
    analysis: {
      max_call_depth: typeof analysis.max_call_depth === "number" ? analysis.max_call_depth : DEFAULT_V2_CONFIG.analysis.max_call_depth,
      max_impact_depth: typeof analysis.max_impact_depth === "number" ? analysis.max_impact_depth : DEFAULT_V2_CONFIG.analysis.max_impact_depth,
    },
    html: { mode: html.mode === "bundle" ? "bundle" : "single-file" },
    ai: { enabled: ai.enabled === true },
  };
}

export async function loadV2Config(repositoryRoot: string): Promise<CodeAtlasV2Config> {
  try {
    const contents = await readFile(path.join(repositoryRoot, ".codeatlas.yml"), "utf8");
    return normalizeV2Config(parseCodeAtlasYaml(contents));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_V2_CONFIG;
    throw error;
  }
}

export function v2ConfigFingerprint(config: CodeAtlasV2Config): string {
  return sha256(JSON.stringify(config));
}
