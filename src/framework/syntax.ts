import type { SyntaxNode } from "../parser/tree-sitter.js";

export function walkSyntax(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walkSyntax(child, visit);
}

export function identifierText(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  return ["identifier", "property_identifier", "type_identifier"].includes(node.type)
    ? node.text
    : null;
}

export function memberParts(node: SyntaxNode | null): string[] | null {
  if (node === null) return null;
  const identifier = identifierText(node);
  if (identifier !== null) return [identifier];
  if (node.type === "this" || node.type === "super") return [node.type];
  if (node.type === "member_expression" || node.type === "attribute") {
    const object = memberParts(node.childForFieldName("object"));
    const property = identifierText(
      node.childForFieldName("property") ?? node.childForFieldName("attribute"),
    );
    return object === null || property === null ? null : [...object, property];
  }
  return null;
}

export function stringLiteralValue(node: SyntaxNode | null): string | null {
  if (node === null || node.type !== "string") return null;
  const fragments = node.namedChildren.filter(
    (child) => child.type === "string_fragment" || child.type === "string_content",
  );
  if (fragments.length > 0) return fragments.map((fragment) => fragment.text).join("");
  const text = node.text;
  const quoteIndex = text.search(/["'`]/u);
  if (quoteIndex < 0 || text.length <= quoteIndex + 1) return null;
  return text.slice(quoteIndex + 1, -1);
}
