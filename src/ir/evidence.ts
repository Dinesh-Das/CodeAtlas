import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hashing.js";
import { resolveExistingPathInside } from "../core/paths.js";
import type { AtlasEvidence } from "./models.js";

export interface EvidenceExcerpt {
  excerpt: string | null;
  status: AtlasEvidence["excerpt_status"];
}

export function createEvidenceId(input: {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  symbolId?: string | null;
  relationshipId?: string | null;
  resolutionIssueId?: string | null;
}): string {
  const identity = [
    input.file.replaceAll("\\", "/"),
    input.startLine,
    input.startColumn,
    input.endLine,
    input.endColumn,
    input.symbolId ?? "",
    input.relationshipId ?? "",
  ];
  if (input.resolutionIssueId !== undefined && input.resolutionIssueId !== null) {
    identity.push(input.resolutionIssueId);
  }
  return `evidence:${sha256(identity.join(":"))}`;
}

export class EvidenceExcerptReader {
  private readonly linesByFile = new Map<string, string[] | null>();

  constructor(
    private readonly repositoryRoot: string,
    private readonly maxLines = 4,
    private readonly maxBytes = 1_000,
  ) {}

  async read(file: string, startLine: number, endLine: number): Promise<EvidenceExcerpt> {
    let lines = this.linesByFile.get(file);
    if (lines === undefined) {
      const absolutePath = await resolveExistingPathInside(
        this.repositoryRoot,
        path.resolve(this.repositoryRoot, file),
      );
      if (absolutePath === null) {
        this.linesByFile.set(file, null);
        return { excerpt: null, status: "unavailable" };
      }
      try {
        lines = (await readFile(absolutePath, "utf8")).split(/\r?\n/u);
      } catch {
        lines = null;
      }
      this.linesByFile.set(file, lines);
    }
    if (lines === null) return { excerpt: null, status: "unavailable" };
    const first = Math.max(0, startLine - 1);
    const last = Math.min(lines.length, Math.max(startLine, endLine), first + this.maxLines);
    const value = lines.slice(first, last).join("\n").trimEnd();
    const lineTruncated = last < Math.min(lines.length, Math.max(startLine, endLine));
    if (Buffer.byteLength(value, "utf8") <= this.maxBytes) {
      return { excerpt: value, status: lineTruncated ? "truncated" : "complete" };
    }
    return {
      excerpt: `${Buffer.from(value, "utf8").subarray(0, this.maxBytes).toString("utf8")}…`,
      status: "truncated",
    };
  }

  async excerpt(file: string, startLine: number, endLine: number): Promise<string | null> {
    return (await this.read(file, startLine, endLine)).excerpt;
  }
}

export function evidenceKind(provenance: string): AtlasEvidence["kind"] {
  if (provenance === "CONFIG" || provenance === "USER_DEFINED") return "config";
  if (provenance === "GIT") return "git";
  if (provenance === "LLM") return "documentation";
  return "source";
}
