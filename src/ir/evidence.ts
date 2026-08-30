import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hashing.js";
import { isPathInside } from "../core/paths.js";
import type { AtlasEvidence } from "./models.js";

export function createEvidenceId(input: {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  symbolId?: string | null;
  relationshipId?: string | null;
}): string {
  return `evidence:${sha256([
    input.file.replaceAll("\\", "/"),
    input.startLine,
    input.startColumn,
    input.endLine,
    input.endColumn,
    input.symbolId ?? "",
    input.relationshipId ?? "",
  ].join(":"))}`;
}

export class EvidenceExcerptReader {
  private readonly linesByFile = new Map<string, string[] | null>();

  constructor(
    private readonly repositoryRoot: string,
    private readonly maxLines = 4,
    private readonly maxBytes = 1_000,
  ) {}

  async excerpt(file: string, startLine: number, endLine: number): Promise<string | null> {
    let lines = this.linesByFile.get(file);
    if (lines === undefined) {
      const absolutePath = path.resolve(this.repositoryRoot, file);
      if (!isPathInside(this.repositoryRoot, absolutePath)) {
        this.linesByFile.set(file, null);
        return null;
      }
      try {
        lines = (await readFile(absolutePath, "utf8")).split(/\r?\n/u);
      } catch {
        lines = null;
      }
      this.linesByFile.set(file, lines);
    }
    if (lines === null) return null;
    const first = Math.max(0, startLine - 1);
    const last = Math.min(lines.length, Math.max(startLine, endLine), first + this.maxLines);
    const value = lines.slice(first, last).join("\n").trimEnd();
    if (Buffer.byteLength(value, "utf8") <= this.maxBytes) return value;
    return `${Buffer.from(value, "utf8").subarray(0, this.maxBytes).toString("utf8")}…`;
  }
}

export function evidenceKind(provenance: string): AtlasEvidence["kind"] {
  if (provenance === "CONFIG" || provenance === "USER_DEFINED") return "config";
  if (provenance === "GIT") return "git";
  if (provenance === "LLM") return "documentation";
  return "source";
}
