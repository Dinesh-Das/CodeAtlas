import type { ParseInput, UnresolvedReference } from "../parser.js";
import type { ParseGraphBuilder, SyntaxNode } from "../tree-sitter.js";

export function generatedSource(input: ParseInput): boolean {
  return (
    /(?:^|\/)(?:generated|__generated__|gen|target\/generated-sources)(?:\/|$)/iu.test(
      input.relativeFilePath,
    ) ||
    /(?:@generated|auto-generated|automatically generated|code generated .* do not edit|do not edit)/iu.test(
      input.content.slice(0, 2_000),
    )
  );
}

export function identifierText(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  return [
    "field_identifier",
    "identifier",
    "package_identifier",
    "type_identifier",
  ].includes(node.type)
    ? node.text
    : null;
}

export function descendantNodes(
  node: SyntaxNode | null,
  predicate: (candidate: SyntaxNode) => boolean,
): SyntaxNode[] {
  if (node === null) return [];
  const result: SyntaxNode[] = [];
  const visit = (candidate: SyntaxNode): void => {
    if (predicate(candidate)) result.push(candidate);
    for (const child of candidate.namedChildren) visit(child);
  };
  visit(node);
  return result;
}

export function addGeneratedReference(
  builder: ParseGraphBuilder,
  root: SyntaxNode,
  generated: boolean,
): void {
  if (!generated) return;
  builder.addReference(
    { name: "generated_code_target", kind: "generated" },
    root,
    {
      provenance: "dynamic",
      confidence: 0.3,
      metadata: { behavior: "generated_code" },
    },
  );
}

export function addDynamicReference(
  builder: ParseGraphBuilder,
  node: SyntaxNode,
  sourceNodeId: string,
  input: {
    name: string;
    kind: Extract<
      UnresolvedReference["kind"],
      "dependency_injection" | "reflection" | "runtime_registration"
    >;
    behavior: string;
    confidence: number;
  },
): void {
  builder.addReference(
    { name: input.name, kind: input.kind, sourceNodeId },
    node,
    {
      provenance: "dynamic",
      confidence: input.confidence,
      metadata: { behavior: input.behavior },
    },
  );
}
