import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/hashing.js";
import { createEvidenceId } from "../ir/evidence.js";
import type {
  Atlas,
  AtlasControlFlow,
  AtlasSymbol,
  ControlFlowNode,
  ControlFlowNodeKind,
} from "../ir/models.js";
import { getLanguageAdapter } from "../parser/registry.js";
import type { SyntaxNode } from "../parser/tree-sitter.js";

const FUNCTION_KINDS = new Set(["function", "method"]);
const BLOCK_TYPES = new Set(["statement_block", "block"]);
const FUNCTION_TYPES = /(?:function|method|lambda|arrow_function)/u;
const LOOP_TYPES = new Set(["for_statement", "for_in_statement", "while_statement"]);
const RAISE_TYPES = new Set(["throw_statement", "raise_statement"]);
const CALL_TYPES = new Set(["call_expression", "call"]);
const UNSUPPORTED_CONTROL_TYPES = new Set([
  "conditional_expression",
  "do_statement",
  "switch_statement",
  "switch_expression",
  "ternary_expression",
  "with_statement",
  "yield",
  "yield_expression",
]);

function containingFunction(root: SyntaxNode, startLine: number, endLine: number): SyntaxNode | null {
  let best: SyntaxNode | null = null;
  const visit = (node: SyntaxNode): void => {
    const nodeStart = node.startPosition.row + 1;
    const nodeEnd = node.endPosition.row + 1;
    if (nodeStart > startLine || nodeEnd < endLine) return;
    if (FUNCTION_TYPES.test(node.type)) best = node;
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return best;
}

interface CompileContext {
  returnTarget: string;
  throwTarget: string;
  breakTarget: string | null;
  continueTarget: string | null;
  variant: string;
}

class StructuredControlFlowBuilder {
  readonly nodes: ControlFlowNode[] = [];
  readonly edges: AtlasControlFlow["edges"] = [];
  readonly supported = new Set<string>();
  readonly unsupported = new Set<string>();
  truncated = false;

  private readonly evidenceIds: Set<string>;

  constructor(
    private readonly atlas: Atlas,
    private readonly symbol: AtlasSymbol,
    private readonly source: string,
    private readonly maxNodes: number,
    readonly startId: string,
    readonly endId: string,
  ) {
    this.evidenceIds = new Set(atlas.evidence.map((evidence) => evidence.id));
    this.nodes.push(
      { id: startId, kind: "START", label: "START", evidence_ids: symbol.evidence_ids },
      { id: endId, kind: "END", label: "END", evidence_ids: symbol.evidence_ids },
    );
  }

  scanConstructs(root: SyntaxNode): void {
    const visit = (node: SyntaxNode, isRoot = false): void => {
      if (!isRoot && FUNCTION_TYPES.test(node.type)) return;
      if (node.type === "if_statement") this.supported.add("if");
      else if (LOOP_TYPES.has(node.type)) this.supported.add("loop");
      else if (node.type === "try_statement") this.supported.add("try");
      else if (node.type === "catch_clause" || node.type === "except_clause") this.supported.add("catch");
      else if (node.type === "finally_clause") this.supported.add("finally");
      else if (node.type === "return_statement") this.supported.add("return");
      else if (RAISE_TYPES.has(node.type)) this.supported.add("raise");
      else if (node.type === "break_statement") this.supported.add("break");
      else if (node.type === "continue_statement") this.supported.add("continue");
      else if (CALL_TYPES.has(node.type)) this.supported.add("call");
      else if (UNSUPPORTED_CONTROL_TYPES.has(node.type)) this.unsupported.add(node.type);
      for (const child of node.namedChildren) visit(child);
    };
    visit(root, true);
  }

  compileFunction(functionNode: SyntaxNode): void {
    const body = functionNode.childForFieldName("body");
    if (body === null) {
      this.addEdge(this.startId, this.endId, null);
      return;
    }
    this.scanConstructs(body);
    const context: CompileContext = {
      returnTarget: this.endId,
      throwTarget: this.endId,
      breakTarget: null,
      continueTarget: null,
      variant: "root",
    };
    const entry = this.compile(body, this.endId, context);
    this.addEdge(this.startId, entry, null);
  }

  private compile(node: SyntaxNode | null, next: string, context: CompileContext): string {
    if (node === null) return next;
    if (FUNCTION_TYPES.test(node.type)) return next;
    if (BLOCK_TYPES.has(node.type)) return this.compileSequence(node.namedChildren, next, context);
    if (node.type === "if_statement") return this.compileIf(node, next, context);
    if (LOOP_TYPES.has(node.type)) return this.compileLoop(node, next, context);
    if (node.type === "try_statement") return this.compileTry(node, next, context);
    if (node.type === "return_statement") {
      return this.compileAbrupt(node, "RETURN", context.returnTarget, "return", context);
    }
    if (RAISE_TYPES.has(node.type)) {
      return this.compileAbrupt(node, "RAISE", context.throwTarget, "raise", context);
    }
    if (node.type === "break_statement") {
      if (context.breakTarget === null) this.unsupported.add("break_outside_supported_loop");
      return this.compileAbrupt(node, "STATEMENT", context.breakTarget ?? next, "break", context);
    }
    if (node.type === "continue_statement") {
      if (context.continueTarget === null) this.unsupported.add("continue_outside_supported_loop");
      return this.compileAbrupt(node, "STATEMENT", context.continueTarget ?? next, "continue", context);
    }
    if (node.type === "else_clause") return this.compileBranch(node, next, context);
    if (node.type === "catch_clause" || node.type === "except_clause") {
      return this.compileCatch(node, next, context);
    }
    if (node.type === "finally_clause") return this.compileFinally(node, next, context);
    if (UNSUPPORTED_CONTROL_TYPES.has(node.type)) {
      this.unsupported.add(node.type);
      const unsupported = this.makeNode(node, "STATEMENT", `${context.variant}:unsupported`);
      if (unsupported !== null) this.addEdge(unsupported.id, next, null);
      return unsupported?.id ?? next;
    }
    return this.compileCalls(node, next, context);
  }

  private compileSequence(nodes: readonly SyntaxNode[], next: string, context: CompileContext): string {
    let entry = next;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      entry = this.compile(nodes[index]!, entry, context);
    }
    return entry;
  }

  private compileIf(node: SyntaxNode, next: string, context: CompileContext): string {
    const conditionNode = this.makeNode(node, "CONDITION", `${context.variant}:if`);
    if (conditionNode === null) return next;
    const consequence = node.childForFieldName("consequence");
    const alternative = node.childForFieldName("alternative");
    const trueEntry = this.compile(consequence, next, {
      ...context,
      variant: `${context.variant}:if:true:${node.startIndex}`,
    });
    const falseEntry = alternative === null
      ? next
      : this.compileBranch(alternative, next, {
          ...context,
          variant: `${context.variant}:if:false:${node.startIndex}`,
        });
    this.addEdge(conditionNode.id, trueEntry, "true");
    this.addEdge(conditionNode.id, falseEntry, "false");
    return this.compileCalls(node.childForFieldName("condition"), conditionNode.id, context);
  }

  private compileBranch(node: SyntaxNode, next: string, context: CompileContext): string {
    const marker = this.makeNode(node, "BRANCH", `${context.variant}:branch`);
    if (marker === null) return next;
    const body = node.childForFieldName("body") ??
      node.namedChildren.find((child) => BLOCK_TYPES.has(child.type)) ?? null;
    const bodyEntry = this.compile(body, next, context);
    this.addEdge(marker.id, bodyEntry, null);
    return marker.id;
  }

  private compileLoop(node: SyntaxNode, next: string, context: CompileContext): string {
    const marker = this.makeNode(node, "LOOP", `${context.variant}:loop`);
    if (marker === null) return next;
    const conditionEntry = this.compileCalls(node.childForFieldName("condition"), marker.id, context);
    const bodyContext: CompileContext = {
      ...context,
      breakTarget: next,
      continueTarget: conditionEntry,
      variant: `${context.variant}:loop:body:${node.startIndex}`,
    };
    const bodyEntry = this.compile(node.childForFieldName("body"), conditionEntry, bodyContext);
    this.addEdge(marker.id, bodyEntry, "body");
    this.addEdge(marker.id, next, "exit");
    this.addEdge(marker.id, marker.id, "repeat");
    return conditionEntry;
  }

  private compileTry(node: SyntaxNode, next: string, context: CompileContext): string {
    const marker = this.makeNode(node, "TRY", `${context.variant}:try`);
    if (marker === null) return next;
    const catchClause = node.namedChildren.find((child) =>
      child.type === "catch_clause" || child.type === "except_clause"
    ) ?? null;
    const finallyClause = node.namedChildren.find((child) => child.type === "finally_clause") ?? null;

    const normalFinally = finallyClause === null ? next : this.compileFinally(
      finallyClause,
      next,
      { ...context, variant: `${context.variant}:finally:normal:${node.startIndex}` },
    );
    const returnFinally = finallyClause === null ? context.returnTarget : this.compileFinally(
      finallyClause,
      context.returnTarget,
      { ...context, variant: `${context.variant}:finally:return:${node.startIndex}` },
    );
    const throwFinally = finallyClause === null ? context.throwTarget : this.compileFinally(
      finallyClause,
      context.throwTarget,
      { ...context, variant: `${context.variant}:finally:throw:${node.startIndex}` },
    );

    let catchEntry: string | null = null;
    if (catchClause !== null) {
      catchEntry = this.compileCatch(catchClause, normalFinally, {
        ...context,
        returnTarget: returnFinally,
        throwTarget: throwFinally,
        variant: `${context.variant}:catch:${node.startIndex}`,
      });
    }
    const bodyEntry = this.compile(node.childForFieldName("body"), normalFinally, {
      ...context,
      returnTarget: returnFinally,
      throwTarget: catchEntry ?? throwFinally,
      variant: `${context.variant}:try:body:${node.startIndex}`,
    });
    this.addEdge(marker.id, bodyEntry, "try");
    if (catchEntry !== null) this.addEdge(marker.id, catchEntry, "catch");
    return marker.id;
  }

  private compileCatch(node: SyntaxNode, next: string, context: CompileContext): string {
    const marker = this.makeNode(node, "CATCH", `${context.variant}:catch`);
    if (marker === null) return next;
    const body = node.childForFieldName("body") ??
      node.namedChildren.find((child) => BLOCK_TYPES.has(child.type)) ?? null;
    const bodyEntry = this.compile(body, next, context);
    this.addEdge(marker.id, bodyEntry, null);
    return marker.id;
  }

  private compileFinally(node: SyntaxNode, next: string, context: CompileContext): string {
    const marker = this.makeNode(node, "FINALLY", `${context.variant}:finally`);
    if (marker === null) return next;
    const body = node.childForFieldName("body") ??
      node.namedChildren.find((child) => BLOCK_TYPES.has(child.type)) ?? null;
    const bodyEntry = this.compile(body, next, context);
    this.addEdge(marker.id, bodyEntry, "finally");
    return marker.id;
  }

  private compileAbrupt(
    node: SyntaxNode,
    kind: ControlFlowNodeKind,
    target: string,
    label: string,
    context: CompileContext,
  ): string {
    const marker = this.makeNode(node, kind, `${context.variant}:${label}`);
    if (marker === null) return target;
    this.addEdge(marker.id, target, label);
    return this.compileCalls(node, marker.id, context);
  }

  private compileCalls(root: SyntaxNode | null, next: string, context: CompileContext): string {
    if (root === null) return next;
    const calls: SyntaxNode[] = [];
    const visit = (node: SyntaxNode, isRoot = false): void => {
      if (!isRoot && FUNCTION_TYPES.test(node.type)) return;
      for (const child of node.namedChildren) visit(child);
      if (CALL_TYPES.has(node.type)) calls.push(node);
    };
    visit(root, true);
    let entry = next;
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const call = this.makeNode(calls[index]!, "CALL", `${context.variant}:call`);
      if (call === null) continue;
      this.addEdge(call.id, entry, null);
      entry = call.id;
    }
    return entry;
  }

  private makeNode(
    syntax: SyntaxNode,
    kind: ControlFlowNodeKind,
    variant: string,
  ): ControlFlowNode | null {
    if (this.nodes.length - 2 >= this.maxNodes) {
      this.truncated = true;
      return null;
    }
    const raw = this.source.slice(syntax.startIndex, syntax.endIndex);
    const normalized = raw.replace(/\s+/gu, " ").trim();
    const oneLine = normalized.slice(0, 120);
    const excerptBytes = Buffer.from(raw.trimEnd(), "utf8");
    const excerptTruncated = excerptBytes.length > 1_000;
    const excerpt = excerptTruncated
      ? `${excerptBytes.subarray(0, 1_000).toString("utf8")}…`
      : excerptBytes.toString("utf8");
    const startLine = syntax.startPosition.row + 1;
    const startColumn = syntax.startPosition.column;
    const endLine = syntax.endPosition.row + 1;
    const endColumn = syntax.endPosition.column;
    const evidenceId = createEvidenceId({
      file: this.symbol.file!,
      startLine,
      startColumn,
      endLine,
      endColumn,
      symbolId: this.symbol.id,
    });
    if (!this.evidenceIds.has(evidenceId)) {
      this.atlas.evidence.push({
        id: evidenceId,
        file: this.symbol.file!,
        start_line: startLine,
        start_column: startColumn,
        end_line: endLine,
        end_column: endColumn,
        symbol_id: this.symbol.id,
        relationship_id: null,
        resolution_issue_id: null,
        kind: "source",
        excerpt: excerpt || null,
        excerpt_status: excerptTruncated ? "truncated" : "complete",
        content_hash: this.symbol.content_hash,
        file_content_hash: this.symbol.content_hash,
        range_content_hash: sha256(raw),
      });
      this.evidenceIds.add(evidenceId);
    }
    const result: ControlFlowNode = {
      id: `cfg-node:${sha256(`${this.symbol.id}:${variant}:${syntax.startIndex}:${syntax.endIndex}:${kind}`)}`,
      kind,
      label: oneLine || kind,
      evidence_ids: [evidenceId],
    };
    this.nodes.push(result);
    return result;
  }

  private addEdge(source: string, target: string, label: string | null): void {
    if (this.edges.some((edge) => edge.source === source && edge.target === target && edge.label === label)) return;
    this.edges.push({
      id: `cfg-edge:${sha256(`${this.symbol.id}:${source}:${target}:${label ?? "next"}`)}`,
      source,
      target,
      label,
    });
  }
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
    const flow = await buildControlFlowForSymbol(atlas, repositoryRoot, symbol, {
      maxNodesPerFunction,
      files,
      trees,
    });
    if (flow !== null) flows.push(flow);
  }
  return flows;
}

export async function buildControlFlowForSymbol(
  atlas: Atlas,
  repositoryRoot: string,
  symbol: AtlasSymbol,
  options: {
    maxNodesPerFunction?: number;
    files?: Map<string, string>;
    trees?: Map<string, SyntaxNode>;
  } = {},
): Promise<AtlasControlFlow | null> {
  if (!FUNCTION_KINDS.has(symbol.kind) || symbol.file === null || symbol.location === null) return null;
  const files = options.files ?? new Map<string, string>();
  const trees = options.trees ?? new Map<string, SyntaxNode>();
  let source = files.get(symbol.file);
  if (source === undefined) {
    try {
      source = await readFile(path.join(repositoryRoot, symbol.file), "utf8");
    } catch {
      return null;
    }
    files.set(symbol.file, source);
  }
  let root = trees.get(symbol.file);
  if (root === undefined) {
    const adapter = getLanguageAdapter(symbol.language as Parameters<typeof getLanguageAdapter>[0]);
    if (adapter === null) return null;
    root = adapter.createSyntaxTree(source);
    trees.set(symbol.file, root);
  }
  const syntax = containingFunction(root, symbol.location.start_line, symbol.location.end_line);
  if (syntax === null) return null;
  const builder = new StructuredControlFlowBuilder(
    atlas,
    symbol,
    source,
    options.maxNodesPerFunction ?? 60,
    `cfg-node:${sha256(`${symbol.id}:START`)}`,
    `cfg-node:${sha256(`${symbol.id}:END`)}`,
  );
  builder.compileFunction(syntax);
  return {
    id: `cfg:${sha256(symbol.id)}`,
    symbol_id: symbol.id,
    nodes: builder.nodes,
    edges: builder.edges,
    truncated: builder.truncated,
    analysis_kind: "structured_ast_approximation",
    supported_constructs: [...builder.supported].sort((left, right) => left.localeCompare(right)),
    unsupported_constructs: [...builder.unsupported].sort((left, right) => left.localeCompare(right)),
  };
}
