import type { NodeKind } from "../../graph/types.js";
import type { LanguageAdapter, ParsedFile, ParseInput } from "../parser.js";
import {
  createTree,
  declarationSignature,
  ParseGraphBuilder,
  sanitizeSignature,
  type AddedSymbol,
  type SyntaxNode,
} from "../tree-sitter.js";

interface EcmaScriptAdapterOptions {
  language: "typescript" | "tsx" | "javascript" | "jsx";
  version: string;
  grammar: unknown;
}

interface Scope {
  parentNodeId: string;
  qualifiedName: string;
  type: "module" | "class" | "interface" | "function";
}

interface PendingExport {
  localName: string;
  syntaxNode: SyntaxNode;
}

const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function_expression",
  "generator_function",
]);

const METHOD_TYPES = new Set([
  "method_definition",
  "method_signature",
  "abstract_method_signature",
]);

function qualifiedName(scope: Scope, name: string): string {
  return scope.qualifiedName === "" ? name : `${scope.qualifiedName}.${name}`;
}

function validName(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  if (
    node.type !== "identifier" &&
    node.type !== "type_identifier" &&
    node.type !== "property_identifier" &&
    node.type !== "private_property_identifier"
  ) {
    return null;
  }
  return node.text;
}

function collectBindingNames(node: SyntaxNode | null): string[] {
  if (node === null) return [];
  const direct = validName(node);
  if (direct !== null) return [direct];
  if (node.type === "pair_pattern") {
    return collectBindingNames(node.childForFieldName("value"));
  }
  if (node.type === "assignment_pattern") {
    return collectBindingNames(node.childForFieldName("left"));
  }
  return node.namedChildren.flatMap(collectBindingNames);
}

function stringValue(node: SyntaxNode | null): string | null {
  if (node === null || node.type !== "string") return null;
  const fragment = node.namedChildren.find(
    (child) => child.type === "string_fragment" || child.type === "string_content",
  );
  if (fragment !== undefined) return fragment.text;
  const text = node.text;
  return text.length >= 2 ? text.slice(1, -1) : null;
}

function visibilityFor(node: SyntaxNode, name: string, fallback: string): string {
  if (name.startsWith("#")) return "private";
  const modifier = node.namedChildren.find((child) => child.type === "accessibility_modifier");
  return modifier?.text ?? fallback;
}

function variableKeyword(node: SyntaxNode): string {
  const declaration = node.parent;
  const first = declaration?.firstChild?.text;
  return first === "let" || first === "var" || first === "const" ? first : "variable";
}

function callableVariableSignature(name: string, value: SyntaxNode): string {
  const parameters = value.childForFieldName("parameters") ?? value.childForFieldName("parameter");
  const returnType = value.childForFieldName("return_type");
  const parameterText = parameters === null ? "()" : sanitizeSignature(parameters.text);
  const returnText = returnType === null ? "" : sanitizeSignature(returnType.text);
  return `${name}${parameterText}${returnText}`;
}

export class EcmaScriptAdapter implements LanguageAdapter {
  readonly language: string;
  readonly version: string;
  private readonly grammar: unknown;

  constructor(options: EcmaScriptAdapterOptions) {
    this.language = options.language;
    this.version = options.version;
    this.grammar = options.grammar;
  }

  parseFile(input: ParseInput): ParsedFile {
    const tree = createTree(this.grammar, input.content);
    const root = tree.rootNode;
    const builder = new ParseGraphBuilder(input, root);
    const moduleScope: Scope = {
      parentNodeId: builder.moduleNodeId,
      qualifiedName: "",
      type: "module",
    };
    const localSymbols = new Map<string, AddedSymbol>();
    const pendingExports: PendingExport[] = [];

    const register = (
      symbol: AddedSymbol,
      scope: Scope,
      exportedAt: SyntaxNode | null,
    ): AddedSymbol => {
      if (scope.type === "module") {
        localSymbols.set(symbol.node.name, symbol);
        if (exportedAt !== null) builder.addExport(symbol.id, exportedAt);
      }
      return symbol;
    };

    const visit = (
      node: SyntaxNode,
      scope: Scope,
      exportedAt: SyntaxNode | null = null,
    ): AddedSymbol[] => {
      if (node.type === "import_statement") {
        const source = node.childForFieldName("source");
        const name = stringValue(source);
        if (name !== null) builder.addReference({ name, kind: "import" }, source ?? node);
        return [];
      }

      if (node.type === "export_statement") {
        const declaration = node.childForFieldName("declaration");
        if (declaration !== null) return visit(declaration, scope, node);

        const source = node.childForFieldName("source");
        const sourceName = stringValue(source);
        if (sourceName !== null) {
          builder.addReference({ name: sourceName, kind: "export" }, source ?? node);
          return [];
        }

        const exportClause = node.namedChildren.find((child) => child.type === "export_clause");
        if (exportClause !== undefined) {
          for (const specifier of exportClause.namedChildren.filter(
            (child) => child.type === "export_specifier",
          )) {
            const name = validName(specifier.childForFieldName("name"));
            if (name !== null) pendingExports.push({ localName: name, syntaxNode: specifier });
          }
        } else {
          const identifier = node.namedChildren.find((child) => child.type === "identifier");
          const name = validName(identifier ?? null);
          if (name !== null) pendingExports.push({ localName: name, syntaxNode: node });
        }
        return [];
      }

      if (
        node.type === "class_declaration" ||
        node.type === "abstract_class_declaration" ||
        node.type === "class"
      ) {
        const name = validName(node.childForFieldName("name")) ?? (exportedAt === null ? null : "default");
        if (name === null) return [];
        const symbol = register(
          builder.addSymbol({
            kind: "class",
            name,
            qualifiedName: qualifiedName(scope, name),
            syntaxNode: node,
            parentNodeId: scope.parentNodeId,
            signature: declarationSignature(input, node),
            visibility: scope.type === "module" ? (exportedAt === null ? "module" : "public") : null,
            metadata: exportedAt !== null && name === "default" ? { anonymousDefault: true } : {},
          }),
          scope,
          exportedAt,
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

      if (node.type === "interface_declaration") {
        const name = validName(node.childForFieldName("name"));
        if (name === null) return [];
        const symbol = register(
          builder.addSymbol({
            kind: "interface",
            name,
            qualifiedName: qualifiedName(scope, name),
            syntaxNode: node,
            parentNodeId: scope.parentNodeId,
            signature: declarationSignature(input, node),
            visibility: scope.type === "module" ? (exportedAt === null ? "module" : "public") : null,
          }),
          scope,
          exportedAt,
        );
        const body = node.childForFieldName("body");
        if (body !== null) {
          const interfaceScope: Scope = {
            parentNodeId: symbol.id,
            qualifiedName: symbol.node.qualifiedName ?? name,
            type: "interface",
          };
          for (const child of body.namedChildren) visit(child, interfaceScope);
        }
        return [symbol];
      }

      if (
        node.type === "function_declaration" ||
        node.type === "generator_function_declaration" ||
        node.type === "function_signature"
      ) {
        const name = validName(node.childForFieldName("name")) ?? (exportedAt === null ? null : "default");
        if (name === null) return [];
        const symbol = register(
          builder.addSymbol({
            kind: "function",
            name,
            qualifiedName: qualifiedName(scope, name),
            syntaxNode: node,
            parentNodeId: scope.parentNodeId,
            signature: declarationSignature(input, node),
            visibility: scope.type === "module" ? (exportedAt === null ? "module" : "public") : "local",
            metadata: exportedAt !== null && name === "default" ? { anonymousDefault: true } : {},
          }),
          scope,
          exportedAt,
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

      if (METHOD_TYPES.has(node.type) && (scope.type === "class" || scope.type === "interface")) {
        const name = validName(node.childForFieldName("name"));
        if (name === null) return [];
        const symbol = builder.addSymbol({
          kind: "method",
          name,
          qualifiedName: qualifiedName(scope, name),
          syntaxNode: node,
          parentNodeId: scope.parentNodeId,
          signature: declarationSignature(input, node),
          visibility: visibilityFor(node, name, "public"),
        });
        const body = node.childForFieldName("body");
        if (body !== null) {
          const methodScope: Scope = {
            parentNodeId: symbol.id,
            qualifiedName: symbol.node.qualifiedName ?? qualifiedName(scope, name),
            type: "function",
          };
          for (const child of body.namedChildren) visit(child, methodScope);
        }
        return [symbol];
      }

      if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
        return node.namedChildren
          .filter((child) => child.type === "variable_declarator")
          .flatMap((child) => visit(child, scope, exportedAt));
      }

      if (node.type === "variable_declarator") {
        const names = collectBindingNames(node.childForFieldName("name"));
        const value = node.childForFieldName("value");
        const isCallable = value !== null && FUNCTION_VALUE_TYPES.has(value.type);
        const added = names.map((name) =>
          register(
            builder.addSymbol({
              kind: isCallable ? "function" : "variable",
              name,
              qualifiedName: qualifiedName(scope, name),
              syntaxNode: node,
              parentNodeId: scope.parentNodeId,
              signature: isCallable
                ? callableVariableSignature(name, value)
                : `${variableKeyword(node)} ${name}`,
              visibility: scope.type === "module" ? (exportedAt === null ? "module" : "public") : "local",
            }),
            scope,
            exportedAt,
          ),
        );
        if (isCallable && value !== null && added[0] !== undefined) {
          const body = value.childForFieldName("body");
          if (body !== null) {
            const functionScope: Scope = {
              parentNodeId: added[0].id,
              qualifiedName: added[0].node.qualifiedName ?? added[0].node.name,
              type: "function",
            };
            for (const child of body.namedChildren) visit(child, functionScope);
          }
        } else if (value !== null) {
          visit(value, scope);
        }
        return added;
      }

      if (node.type === "public_field_definition" || node.type === "property_signature") {
        const name = validName(node.childForFieldName("name"));
        if (name === null) return [];
        const value = node.childForFieldName("value");
        const callable = value !== null && FUNCTION_VALUE_TYPES.has(value.type);
        const kind: NodeKind = callable && scope.type === "class" ? "method" : "variable";
        const symbol = builder.addSymbol({
          kind,
          name,
          qualifiedName: qualifiedName(scope, name),
          syntaxNode: node,
          parentNodeId: scope.parentNodeId,
          signature: callable && value !== null
            ? callableVariableSignature(name, value)
            : `${name}${sanitizeSignature(node.childForFieldName("type")?.text ?? "")}`,
          visibility: visibilityFor(node, name, "public"),
        });
        return [symbol];
      }

      if (node.type === "call_expression") {
        const callable = node.childForFieldName("function");
        if (callable?.text === "require" || callable?.type === "import") {
          const argument = node.childForFieldName("arguments")?.namedChildren[0] ?? null;
          const name = stringValue(argument);
          if (name !== null) builder.addReference({ name, kind: "import" }, argument ?? node);
        }
      }

      if (node.type === "assignment_expression") {
        const left = node.childForFieldName("left")?.text;
        const rightName = validName(node.childForFieldName("right"));
        if (rightName !== null && (left === "module.exports" || left?.startsWith("exports.") === true)) {
          pendingExports.push({ localName: rightName, syntaxNode: node });
        }
      }

      const added: AddedSymbol[] = [];
      for (const child of node.namedChildren) added.push(...visit(child, scope));
      return added;
    };

    for (const child of root.namedChildren) visit(child, moduleScope);
    for (const pending of pendingExports) {
      const symbol = localSymbols.get(pending.localName);
      if (symbol !== undefined) {
        builder.addExport(symbol.id, pending.syntaxNode);
      } else {
        builder.addReference(
          { name: pending.localName, kind: "export" },
          pending.syntaxNode,
        );
      }
    }

    return builder.result();
  }
}
