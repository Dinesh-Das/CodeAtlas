import { readFile } from "node:fs/promises";
import path from "node:path";
import JavaScriptLanguage from "tree-sitter-javascript";
import PythonLanguage from "tree-sitter-python";
import TypeScriptLanguages from "tree-sitter-typescript";
import { sha256 } from "../core/hashing.js";
import type {
  Atlas,
  AtlasControlFlow,
  ControlFlowNode,
  ControlFlowNodeKind,
} from "../ir/models.js";
import { createTree, type SyntaxNode } from "../parser/tree-sitter.js";

const FUNCTION_KINDS = new Set(["function", "method"]);

function grammar(language: string | null): unknown | null {
  if (language === "typescript") return TypeScriptLanguages.typescript;
  if (language === "tsx") return TypeScriptLanguages.tsx;
  if (language === "javascript" || language === "jsx") return JavaScriptLanguage;
  if (language === "python") return PythonLanguage;
  return null;
}

function cfgKind(type: string): ControlFlowNodeKind | null {
  if (/^(?:if_statement|conditional_expression)$/u.test(type)) return "CONDITION";
  if (/^(?:else_clause|elif_clause)$/u.test(type)) return "BRANCH";
  if (/^(?:for_statement|for_in_statement|while_statement)$/u.test(type)) return "LOOP";
  if (/^(?:try_statement)$/u.test(type)) return "TRY";
  if (/^(?:catch_clause|except_clause)$/u.test(type)) return "CATCH";
  if (/^(?:finally_clause)$/u.test(type)) return "FINALLY";
  if (/^(?:return_statement)$/u.test(type)) return "RETURN";
  if (/^(?:throw_statement|raise_statement)$/u.test(type)) return "RAISE";
  if (/^(?:call_expression|call)$/u.test(type)) return "CALL";
  return null;
}

function containingFunction(root: SyntaxNode, startLine: number, endLine: number): SyntaxNode | null {
  let best: SyntaxNode | null = null;
  const visit = (node: SyntaxNode): void => {
    const nodeStart = node.startPosition.row + 1;
    const nodeEnd = node.endPosition.row + 1;
    if (nodeStart > startLine || nodeEnd < endLine) return;
    if (/function|method|lambda/u.test(node.type)) best = node;
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return best;
}

function interestingNodes(root: SyntaxNode, maxNodes: number): Array<{
  syntax: SyntaxNode;
  kind: ControlFlowNodeKind;
}> {
  const result: Array<{ syntax: SyntaxNode; kind: ControlFlowNodeKind }> = [];
  const visit = (node: SyntaxNode): void => {
    if (result.length >= maxNodes) return;
    const kind = cfgKind(node.type);
    if (kind !== null) result.push({ syntax: node, kind });
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  result.sort((left, right) =>
    left.syntax.startIndex - right.syntax.startIndex || left.syntax.endIndex - right.syntax.endIndex,
  );
  return result;
}

export async function buildControlFlows(
  atlas: Atlas,
  repositoryRoot: string,
  options: { maxFunctions?: number; maxNodesPerFunction?: number } = {},
): Promise<AtlasControlFlow[]> {
  const maxFunctions = options.maxFunctions ?? 300;
  const maxNodesPerFunction = options.maxNodesPerFunction ?? 60;
  const files = new Map<string, string>();
  const trees = new Map<string, SyntaxNode>();
  const symbols = atlas.symbols.filter((symbol) =>
    FUNCTION_KINDS.has(symbol.kind) && symbol.file !== null && symbol.location !== null,
  ).slice(0, maxFunctions);
  const flows: AtlasControlFlow[] = [];

  for (const symbol of symbols) {
    const file = symbol.file!;
    let source = files.get(file);
    if (source === undefined) {
      try {
        source = await readFile(path.join(repositoryRoot, file), "utf8");
      } catch {
        continue;
      }
      files.set(file, source);
    }
    let root = trees.get(file);
    if (root === undefined) {
      const selectedGrammar = grammar(symbol.language);
      if (selectedGrammar === null) continue;
      root = createTree(selectedGrammar, source).rootNode;
      trees.set(file, root);
    }
    const syntax = containingFunction(
      root,
      symbol.location!.start_line,
      symbol.location!.end_line,
    );
    if (syntax === null) continue;
    const selected = interestingNodes(syntax, maxNodesPerFunction);
    const startId = `cfg-node:${sha256(`${symbol.id}:START`)}`;
    const endId = `cfg-node:${sha256(`${symbol.id}:END`)}`;
    const nodes: ControlFlowNode[] = [{
      id: startId,
      kind: "START",
      label: "START",
      evidence_ids: symbol.evidence_ids,
    }];
    for (const [index, item] of selected.entries()) {
      const oneLine = source.slice(item.syntax.startIndex, item.syntax.endIndex)
        .replace(/\s+/gu, " ").trim().slice(0, 120);
      nodes.push({
        id: `cfg-node:${sha256(`${symbol.id}:${index}:${item.syntax.startIndex}:${item.kind}`)}`,
        kind: item.kind,
        label: oneLine || item.kind,
        evidence_ids: symbol.evidence_ids,
      });
    }
    nodes.push({
      id: endId,
      kind: "END",
      label: "END",
      evidence_ids: symbol.evidence_ids,
    });
    const edges = nodes.slice(0, -1).map((node, index) => ({
      id: `cfg-edge:${sha256(`${symbol.id}:${node.id}:${nodes[index + 1]!.id}`)}`,
      source: node.id,
      target: nodes[index + 1]!.id,
      label: node.kind === "CONDITION" ? "next" : null,
    }));
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      if (node.kind !== "CONDITION" && node.kind !== "LOOP" && node.kind !== "TRY") continue;
      const target = nodes[Math.min(nodes.length - 1, index + 2)]!;
      edges.push({
        id: `cfg-edge:${sha256(`${symbol.id}:${node.id}:${target.id}:alternate`)}`,
        source: node.id,
        target: target.id,
        label: node.kind === "CONDITION" ? "false" : "alternate",
      });
    }
    flows.push({
      id: `cfg:${sha256(symbol.id)}`,
      symbol_id: symbol.id,
      nodes,
      edges,
      truncated: selected.length >= maxNodesPerFunction,
    });
  }
  return flows;
}
