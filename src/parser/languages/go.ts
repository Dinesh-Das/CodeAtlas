import GoLanguage from "tree-sitter-go";
import type { LanguageAdapter, ParsedFile, ParseInput } from "../parser.js";
import {
  createTree,
  declarationSignature,
  ParseGraphBuilder,
  type AddedSymbol,
  type SyntaxNode,
} from "../tree-sitter.js";
import {
  addDynamicReference,
  addGeneratedReference,
  descendantNodes,
  generatedSource,
  identifierText,
} from "./common.js";

interface Scope {
  parentNodeId: string;
  qualifiedName: string;
  type: "module" | "class" | "function";
}

function qualifiedName(scope: Scope, name: string): string {
  return scope.qualifiedName === "" ? name : `${scope.qualifiedName}.${name}`;
}

function exported(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

function stringValue(node: SyntaxNode | null): string | null {
  if (node === null || node.type !== "interpreted_string_literal") return null;
  const content = node.namedChildren.find((child) =>
    child.type === "interpreted_string_literal_content"
  );
  return content?.text ?? null;
}

function referenceTarget(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  const direct = identifierText(node);
  if (direct !== null) return direct;
  if (node.type === "selector_expression") {
    const object = referenceTarget(node.childForFieldName("operand"));
    const field = identifierText(node.childForFieldName("field"));
    return object === null || field === null ? field : `${object}.${field}`;
  }
  if (node.type === "parenthesized_expression" || node.type === "pointer_type") {
    return referenceTarget(node.namedChildren[0] ?? null);
  }
  return null;
}

function receiverType(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  const named = descendantNodes(node, (candidate) => candidate.type === "type_identifier");
  return identifierText(named.at(-1) ?? null);
}

function importBinding(node: SyntaxNode): {
  path: string;
  localName: string;
} | null {
  const importPath = stringValue(node.childForFieldName("path"));
  if (importPath === null) return null;
  const alias = identifierText(node.childForFieldName("name"));
  return {
    path: importPath,
    localName: alias ?? importPath.split("/").at(-1) ?? importPath,
  };
}

function callTarget(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName("function");
}

const REFLECTION_CALLS = new Set([
  "plugin.Lookup",
  "reflect.Value.Call",
  "reflect.Value.MethodByName",
]);
const REGISTRATION_METHODS = new Set(["Bind", "Handle", "Provide", "Register"]);

export const goAdapter: LanguageAdapter = {
  language: "go",
  version: "go-tree-sitter-1@0.23.4",
  engine: "tree-sitter",

  createSyntaxTree(content: string): SyntaxNode {
    return createTree(GoLanguage, content).rootNode;
  },

  parseFile(input: ParseInput): ParsedFile {
    const root = this.createSyntaxTree(input.content);
    const builder = new ParseGraphBuilder(input, root);
    const packageName = identifierText(
      root.namedChildren.find((child) => child.type === "package_clause")
        ?.namedChildren.find((child) => child.type === "package_identifier") ?? null,
    ) ?? "";
    const moduleScope: Scope = {
      parentNodeId: builder.moduleNodeId,
      qualifiedName: packageName,
      type: "module",
    };
    const types = new Map<string, AddedSymbol>();

    const addType = (typeSpec: SyntaxNode): void => {
      const name = identifierText(typeSpec.childForFieldName("name"));
      const definition = typeSpec.childForFieldName("type");
      if (name === null || definition === null) return;
      const kind = definition.type === "interface_type" ? "interface" : "class";
      const symbol = builder.addSymbol({
        kind,
        name,
        qualifiedName: qualifiedName(moduleScope, name),
        syntaxNode: typeSpec,
        parentNodeId: builder.moduleNodeId,
        signature: declarationSignature(input, typeSpec),
        visibility: exported(name) ? "public" : "module",
      });
      types.set(name, symbol);
      if (exported(name)) builder.addExport(symbol.id, typeSpec);

      if (definition.type === "interface_type") {
        for (const method of descendantNodes(definition, (candidate) =>
          candidate.type === "method_elem"
        )) {
          const methodName = identifierText(method.childForFieldName("name"));
          if (methodName === null) continue;
          const added = builder.addSymbol({
            kind: "method",
            name: methodName,
            qualifiedName: `${symbol.node.qualifiedName}.${methodName}`,
            syntaxNode: method,
            parentNodeId: symbol.id,
            signature: declarationSignature(input, method),
            visibility: exported(methodName) ? "public" : "module",
          });
          if (exported(methodName)) builder.addExport(added.id, method);
        }
      }
    };

    for (const declaration of root.namedChildren.filter((child) => child.type === "type_declaration")) {
      for (const spec of declaration.namedChildren.filter((child) => child.type === "type_spec")) {
        addType(spec);
      }
    }

    const visitCalls = (node: SyntaxNode, scope: Scope): void => {
      if (node.type === "call_expression") {
        const callable = callTarget(node);
        const target = referenceTarget(callable);
        if (target === null) {
          addDynamicReference(builder, callable ?? node, scope.parentNodeId, {
            name: "computed_callable",
            kind: "reflection",
            behavior: "computed_or_reflective_call",
            confidence: 0.25,
          });
        } else {
          builder.addReference(
            { name: target, kind: "call", sourceNodeId: scope.parentNodeId },
            callable ?? node,
          );
          const method = target.split(".").at(-1) ?? target;
          if (
            REFLECTION_CALLS.has(target) ||
            /(?:^|\W)(?:plugin|reflect)\./u.test(callable?.text ?? "")
          ) {
            addDynamicReference(builder, callable ?? node, scope.parentNodeId, {
              name: "reflective_target",
              kind: "reflection",
              behavior: "runtime_reflection",
              confidence: 0.3,
            });
          }
          if (REGISTRATION_METHODS.has(method)) {
            const argument = node.childForFieldName("arguments")?.namedChildren.at(-1);
            const registered = referenceTarget(argument ?? null);
            if (registered !== null) {
              addDynamicReference(builder, argument ?? node, scope.parentNodeId, {
                name: registered,
                kind: "runtime_registration",
                behavior: "runtime_registration",
                confidence: 0.6,
              });
            }
          }
        }
      }
      for (const child of node.namedChildren) visitCalls(child, scope);
    };

    for (const child of root.namedChildren) {
      if (child.type === "import_declaration") {
        for (const spec of descendantNodes(child, (candidate) => candidate.type === "import_spec")) {
          const binding = importBinding(spec);
          if (binding === null) continue;
          builder.addReference({
            name: binding.path,
            kind: "import",
            sourceNodeId: builder.moduleNodeId,
            localName: binding.localName,
            importedName: "*",
          }, spec.childForFieldName("path") ?? spec);
        }
        continue;
      }
      if (child.type !== "function_declaration" && child.type !== "method_declaration") continue;
      const name = identifierText(child.childForFieldName("name"));
      if (name === null) continue;
      const owner = child.type === "method_declaration"
        ? receiverType(child.childForFieldName("receiver"))
        : null;
      const parent = owner === null ? null : types.get(owner) ?? null;
      const functionScope: Scope = {
        parentNodeId: parent?.id ?? builder.moduleNodeId,
        qualifiedName: parent?.node.qualifiedName ?? moduleScope.qualifiedName,
        type: parent === null ? "function" : "class",
      };
      const symbol = builder.addSymbol({
        kind: parent === null ? "function" : "method",
        name,
        qualifiedName: qualifiedName(functionScope, name),
        syntaxNode: child,
        parentNodeId: functionScope.parentNodeId,
        signature: declarationSignature(input, child),
        visibility: exported(name) ? "public" : "module",
      });
      if (exported(name)) builder.addExport(symbol.id, child);
      const body = child.childForFieldName("body");
      if (body !== null) {
        visitCalls(body, {
          parentNodeId: symbol.id,
          qualifiedName: symbol.node.qualifiedName ?? name,
          type: "function",
        });
      }
    }

    addGeneratedReference(builder, root, generatedSource(input));
    return builder.result();
  },
};
