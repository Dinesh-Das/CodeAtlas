import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { workspacePaths } from "../core/workspace.js";
import { openDatabase } from "../storage/database.js";
import type { FreshContext } from "./freshness.js";
import {
  evidenceForNode,
  freshnessFor,
  nodeFact,
  resolveTarget,
} from "./query.js";
import { answerPacketSchema, type AnswerPacket } from "./schemas.js";

function packet(
  value: Omit<AnswerPacket, "freshness" | "security">,
  context: FreshContext,
): AnswerPacket {
  return answerPacketSchema.parse({ ...value, freshness: freshnessFor(context) });
}

export function statusPacket(context: FreshContext): AnswerPacket {
  const statusEvidence = { file: ".codeatlas/state.json", line: 1 };
  const enabledLanguages = Object.entries(context.config.languages)
    .filter(([, enabled]) => enabled)
    .map(([language]) => language)
    .join(", ");
  const status = context.status;
  return packet(
    {
      answer_context: { topic: "repository status", tool: "codeatlas_status" },
      facts: [
        {
          statement: status.synchronized
            ? status.freshnessMode === "authoritative"
              ? `Repository ${status.repository} is indexed and synchronized with the authoritatively checked working tree.`
              : `Repository ${status.repository} is indexed and synchronized under the filesystem-watch cache; the last authoritative check was ${status.authoritativeCheckedAt}.`
            : `Repository ${status.repository} has a current structural graph; one or more derived generations are stale.`,
          confidence: 1,
          source_type: "config",
          provenance: "verified",
          evidence: statusEvidence,
        },
        {
          statement: `Current commit ${status.headCommit} matches indexed commit ${status.indexedCommit}.`,
          confidence: 1,
          source_type: "git",
          provenance: "git",
          evidence: { file: ".git/HEAD", line: 1 },
        },
        {
          statement: `Working tree dirty state is ${String(status.dirty)}; freshness mode is ${status.freshnessMode}, the authoritative check was ${status.authoritativeCheckedAt}, and the checked fingerprint is ${status.currentFingerprint}.`,
          confidence: 1,
          source_type: "git",
          provenance: "git",
          evidence: statusEvidence,
        },
        {
          statement: `Enabled languages are ${enabledLanguages || "none"}; the index contains ${status.files} files, ${status.symbols} symbols, and ${status.edges} relationships.`,
          confidence: 1,
          source_type: "config",
          provenance: "verified",
          evidence: { file: ".codeatlas/config.json", line: 1 },
        },
        {
          statement: `The repository was last indexed at ${status.lastIndexedAt}.`,
          confidence: 1,
          source_type: "config",
          provenance: "verified",
          evidence: statusEvidence,
        },
        {
          statement: `Generations are structural=${status.generations.structural}, semantic=${status.generations.semantic}, search=${status.generations.search}, architecture=${status.generations.architecture}.`,
          confidence: 1,
          source_type: "config",
          provenance: "verified",
          evidence: statusEvidence,
        },
      ],
      relationships: [],
      source_snippets: [],
      uncertainties: status.synchronized
        ? []
        : [
            {
              description: "One or more derived index generations do not match the current structural generation.",
              reason: "insufficient_evidence",
              candidates: [],
            },
          ],
      pagination: { cursor: null, has_more: false },
    },
    context,
  );
}

function isWithinRepository(repositoryRoot: string, candidate: string): boolean {
  const relative = path.relative(repositoryRoot, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function sourcePacket(
  context: FreshContext,
  input: { node_id: string },
): Promise<AnswerPacket> {
  const database = openDatabase(workspacePaths(context.status.root).database, { readonly: true });
  try {
    const resolution = resolveTarget(database, input.node_id);
    if (resolution.node === null) {
      return packet(
        {
          answer_context: { topic: input.node_id, tool: "codeatlas_source" },
          facts: [],
          relationships: [],
          source_snippets: [],
          uncertainties: [resolution.uncertainty!],
          pagination: { cursor: null, has_more: false },
        },
        context,
      );
    }
    const node = resolution.node;
    if (node.filePath === null || node.filePath === ".") {
      return packet(
        {
          answer_context: { topic: node.name, tool: "codeatlas_source" },
          facts: [nodeFact(node)],
          relationships: [],
          source_snippets: [],
          uncertainties: [
            {
              description: `${node.kind} ${node.name} does not have a source-file range.`,
              reason: "insufficient_evidence",
              candidates: [node.id],
            },
          ],
          pagination: { cursor: null, has_more: false },
        },
        context,
      );
    }

    const repositoryRoot = await realpath(context.status.root);
    const sourcePath = await realpath(path.resolve(repositoryRoot, node.filePath));
    if (!isWithinRepository(repositoryRoot, sourcePath)) {
      return packet(
        {
          answer_context: { topic: node.name, tool: "codeatlas_source" },
          facts: [nodeFact(node)],
          relationships: [],
          source_snippets: [],
          uncertainties: [
            {
              description: "The indexed source path now resolves outside the repository root.",
              reason: "insufficient_evidence",
              candidates: [node.id],
            },
          ],
          pagination: { cursor: null, has_more: false },
        },
        context,
      );
    }

    const lines = (await readFile(sourcePath, "utf8")).split(/\r?\n/u);
    const requestedStart = Math.max(1, node.startLine ?? 1);
    const requestedEnd = Math.max(
      requestedStart,
      node.endLine ?? (node.kind === "file" || node.kind === "module" ? lines.length : requestedStart),
    );
    const maxLines = context.config.limits.maxSourceSnippetLines;
    const startLine = Math.min(requestedStart, Math.max(1, lines.length));
    const endLine = Math.min(requestedEnd, startLine + maxLines - 1, Math.max(1, lines.length));
    let content = lines.slice(startLine - 1, endLine).join("\n");
    let actualEndLine = endLine;
    const uncertainties: AnswerPacket["uncertainties"] = [];
    if (requestedEnd > endLine) {
      uncertainties.push({
        description: `The source range was truncated to config.limits.maxSourceSnippetLines (${maxLines}).`,
        reason: "insufficient_evidence",
        candidates: [node.id],
      });
    }
    const maxBytes = context.config.limits.maxSourceSnippetBytes;
    const encoded = Buffer.from(content, "utf8");
    if (encoded.byteLength > maxBytes) {
      content = encoded.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
      actualEndLine = startLine + content.split("\n").length - 1;
      uncertainties.push({
        description: `The source range was truncated to config.limits.maxSourceSnippetBytes (${maxBytes}).`,
        reason: "insufficient_evidence",
        candidates: [node.id],
      });
    }
    return packet(
      {
        answer_context: { topic: node.name, tool: "codeatlas_source" },
        facts: [
          {
            statement: `Current working-tree source for ${node.kind} ${node.name} spans ${node.filePath}:${startLine}-${actualEndLine}.`,
            confidence: node.confidence,
            source_type: node.sourceType,
            provenance: node.provenance,
            evidence: evidenceForNode(node),
          },
        ],
        relationships: [],
        source_snippets: [
          {
            node_id: node.id,
            file: node.filePath,
            start_line: startLine,
            end_line: actualEndLine,
            content,
            trust: "untrusted_repository_content",
          },
        ],
        uncertainties,
        pagination: { cursor: null, has_more: false },
      },
      context,
    );
  } finally {
    database.close();
  }
}
