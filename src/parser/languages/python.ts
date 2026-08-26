import PythonLanguage from "tree-sitter-python";
import type { LanguageAdapter, ParsedFile, ParseInput } from "../parser.js";
import {
  createTree,
  declarationSignature,
  ParseGraphBuilder,
  sanitizeSignature,
  type AddedSymbol,
  type SyntaxNode,
} from "../tree-sitter.js";

interface Scope {
  parentNodeId: string;
  qualifiedName: string;
  type: "module" | "class" | "function";
}

function qualifiedName(scope: Scope, name: string): string {
  return scope.qualifiedName === "" ? name : `${scope.qualifiedName}.${name}`;
}

function identifierName(node: SyntaxNode | null): string | null {
  return node?.type === "identifier" ? node.text : null;
}

function collectIdentifiers(node: SyntaxNode | null): string[] {
  if (node === null) return [];
  const direct = identifierName(node);
  if (direct !== null) return [direct];
  if (node.type === "attribute" || node.type === "subscript") return [];
  return node.namedChildren.flatMap(collectIdentifiers);
}

function pythonStringValue(node: SyntaxNode): string | null {
  if (node.type !== "string") return null;
  const content = node.namedChildren.find((child) => child.type === "string_content");
  return content?.text ?? null;
}

function visibility(name: string, scope: Scope): string {
  if (name.startsWith("__") && !name.endsWith("__")) return "private";
  if (name.startsWith("_")) return "protected";
  return scope.type === "module" ? "module" : "public";
}

function callableAssignmentSignature(name: string, value: SyntaxNode): string {
  const parameters = value.childForFieldName("parameters");
  return `${name}${parameters === null ? "()" : sanitizeSignature(parameters.text)}`;
}

export const pythonAdapter: LanguageAdapter = {
  language: "python",
  version: "python-tree-sitter-1@0.23.4",

  parseFile(input: ParseInput): ParsedFile {
    const tree = createTree(PythonLanguage, input.content);
    const root = tree.rootNode;
    const builder = new ParseGraphBuilder(input, root);
    const moduleScope: Scope = {
      parentNodeId: builder.moduleNodeId,
      qualifiedName: "",
      type: "module",
    };
    const topLevelSymbols = new Map<string, AddedSymbol>();
    const explicitExports = new Map<string, SyntaxNode>();
    let hasExplicitExports = false;

    const register = (symbol: AddedSymbol, scope: Scope): AddedSymbol => {
      if (scope.type === "module") topLevelSymbols.set(symbol.node.name, symbol);
      return symbol;
    };

    const visit = (node: SyntaxNode, scope: Scope): AddedSymbol[] => {
      if (node.type === "import_statement") {
        const imported = node.childrenForFieldName("name");
        for (const item of imported.length > 0 ? imported : node.namedChildren) {
          const source = item.type === "aliased_import" ? item.childForFieldName("name") : item;
          if (source !== null) builder.addReference({ name: source.text, kind: "import" }, source);
        }
        return [];
      }

      if (node.type === "import_from_statement") {
        const moduleName = node.childForFieldName("module_name");
        if (moduleName !== null) {
          builder.addReference({ name: moduleName.text, kind: "import" }, moduleName);
        }
        return [];
      }

      if (node.type === "decorated_definition") {
        const definition = node.childForFieldName("definition");
        return definition === null ? [] : visit(definition, scope);
      }

      if (node.type === "class_definition") {
        const name = identifierName(node.childForFieldName("name"));
        if (name === null) return [];
        const symbol = register(
          builder.addSymbol({
            kind: "class",
            name,
            qualifiedName: qualifiedName(scope, name),
            syntaxNode: node,
            parentNodeId: scope.parentNodeId,
            signature: declarationSignature(input, node),
            visibility: visibility(name, scope),
          }),
          scope,
        );
        const body = node.childForFieldName("body");
        if (body !== null) {
          const classScope: Scope = {
            parentNodeId: symbol.id,
            qualifiedName: symbol.node.qualifiedName ?? name,
            type: "class",
          };
          for (const child of body.namedChildren) visit(child, classScope);
        }
        return [symbol];
      }

      if (node.type === "function_definition") {
        const name = identifierName(node.childForFieldName("name"));
        if (name === null) return [];
        const isMethod = scope.type === "class";
        const symbol = register(
          builder.addSymbol({
            kind: isMethod ? "method" : "function",
            name,
            qualifiedName: qualifiedName(scope, name),
            syntaxNode: node,
            parentNodeId: scope.parentNodeId,
            signature: declarationSignature(input, node),
            visibility: visibility(name, scope),
            metadata: node.firstChild?.text === "async" ? { async: true } : {},
          }),
          scope,
        );
        const body = node.childForFieldName("body");
        if (body !== null) {
          const functionScope: Scope = {
            parentNodeId: symbol.id,
            qualifiedName: symbol.node.qualifiedName ?? name,
            type: "function",
          };
          for (const child of body.namedChildren) visit(child, functionScope);
        }
        return [symbol];
      }

      if (node.type === "expression_statement") {
        return node.namedChildren.flatMap((child) => visit(child, scope));
      }

      if (node.type === "assignment") {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        const names = collectIdentifiers(left);

        if (scope.type === "module" && names.includes("__all__")) {
          hasExplicitExports = true;
          if (right?.type === "list" || right?.type === "tuple") {
            for (const item of right.namedChildren) {
              const name = pythonStringValue(item);
              if (name !== null) explicitExports.set(name, item);
            }
          }
        }

        const callable = right?.type === "lambda";
        const type = node.childForFieldName("type");
        const added = names.map((name) =>
          register(
            builder.addSymbol({
              kind: callable ? "function" : "variable",
              name,
              qualifiedName: qualifiedName(scope, name),
              syntaxNode: node,
              parentNodeId: scope.parentNodeId,
              signature: callable && right !== null
                ? callableAssignmentSignature(name, right)
                : `${name}${type === null ? "" : `: ${sanitizeSignature(type.text)}`}`,
              visibility: visibility(name, scope),
            }),
            scope,
          ),
        );

        if (right?.type === "assignment") visit(right, scope);
        return added;
      }

      const added: AddedSymbol[] = [];
      for (const child of node.namedChildren) added.push(...visit(child, scope));
      return added;
    };

    for (const child of root.namedChildren) visit(child, moduleScope);

    if (hasExplicitExports) {
      for (const [name, syntaxNode] of explicitExports) {
        const symbol = topLevelSymbols.get(name);
        if (symbol !== undefined) builder.addExport(symbol.id, syntaxNode);
        else builder.addReference({ name, kind: "export" }, syntaxNode);
      }
    } else {
      for (const symbol of topLevelSymbols.values()) {
        if (!symbol.node.name.startsWith("_")) {
          builder.addExport(symbol.id, symbol.syntaxNode, "heuristic", 0.7);
        }
      }
    }

    return builder.result();
  },
};
