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

const CALLBACK_CALLS = new Set(["filter", "map", "reduce"]);
const CALLBACK_METHODS = new Set(["apply_async", "submit", "then"]);
const EVENT_SUBSCRIBE_METHODS = new Set([
  "add_listener",
  "connect",
  "listen",
  "on",
  "subscribe",
]);
const QUEUE_SUBSCRIBE_METHODS = new Set(["consume", "process", "worker"]);
const EVENT_PUBLISH_METHODS = new Set(["dispatch", "emit", "send"]);
const QUEUE_PUBLISH_METHODS = new Set(["delay", "enqueue", "publish", "send_task"]);
const REGISTRATION_METHODS = new Set(["bind", "provide", "register", "register_handler"]);
const REFLECTION_CALLS = new Set([
  "__import__",
  "eval",
  "exec",
  "getattr",
  "globals",
  "locals",
  "setattr",
]);

function qualifiedName(scope: Scope, name: string): string {
  return scope.qualifiedName === "" ? name : `${scope.qualifiedName}.${name}`;
}

function identifierName(node: SyntaxNode | null): string | null {
  return node?.type === "identifier" ? node.text : null;
}

function referenceTarget(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") {
    const object = referenceTarget(node.childForFieldName("object"));
    const attribute = identifierName(node.childForFieldName("attribute"));
    return object === null || attribute === null ? null : `${object}.${attribute}`;
  }
  if (node.type === "subscript") {
    return referenceTarget(node.childForFieldName("value"));
  }
  if (node.type === "dotted_name") {
    const parts = node.namedChildren.map((child) => identifierName(child)).filter(Boolean);
    return parts.length === 0 ? null : parts.join(".");
  }
  return null;
}

function callArguments(node: SyntaxNode): SyntaxNode[] {
  return node.childForFieldName("arguments")?.namedChildren ?? [];
}

function generatedSource(input: ParseInput): boolean {
  return (
    /(?:^|\/)(?:generated|__generated__|gen)(?:\/|$)/iu.test(input.relativeFilePath) ||
    /(?:@generated|auto-generated|automatically generated|do not edit)/iu.test(
      input.content.slice(0, 2_000),
    )
  );
}

function importNameAndAlias(node: SyntaxNode): {
  importedName: string;
  localName: string;
} | null {
  if (node.type === "aliased_import") {
    const importedName = referenceTarget(node.childForFieldName("name"));
    const localName = identifierName(node.childForFieldName("alias"));
    return importedName === null || localName === null ? null : { importedName, localName };
  }
  const importedName = referenceTarget(node);
  if (importedName === null) return null;
  return { importedName, localName: importedName.split(".")[0] ?? importedName };
}

function isValueReference(node: SyntaxNode): boolean {
  if (node.type !== "identifier") return false;
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.childForFieldName("name")?.id === node.id) return false;
  if (parent.childForFieldName("attribute")?.id === node.id) return false;
  if (parent.childForFieldName("function")?.id === node.id) return false;
  return ![
    "parameters",
    "typed_parameter",
    "default_parameter",
    "import_statement",
    "import_from_statement",
    "aliased_import",
    "dotted_name",
    "type",
  ].includes(parent.type);
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
  version: "python-tree-sitter-2@0.23.4",
  engine: "tree-sitter",

  createSyntaxTree(content: string): SyntaxNode {
    return createTree(PythonLanguage, content).rootNode;
  },

  parseFile(input: ParseInput): ParsedFile {
    const root = this.createSyntaxTree(input.content);
    const builder = new ParseGraphBuilder(input, root);
    const generated = generatedSource(input);
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
          const binding = importNameAndAlias(item);
          const source = item.type === "aliased_import" ? item.childForFieldName("name") : item;
          if (source !== null && binding !== null) {
            builder.addReference(
              {
                name: binding.importedName,
                kind: "import",
                sourceNodeId: scope.parentNodeId,
                localName: binding.localName,
                importedName: "*",
              },
              source,
            );
          }
        }
        return [];
      }

      if (node.type === "import_from_statement") {
        const moduleName = node.childForFieldName("module_name");
        if (moduleName !== null) {
          const imported = node.childrenForFieldName("name");
          const bindings = imported
            .map(importNameAndAlias)
            .filter((binding): binding is NonNullable<typeof binding> => binding !== null);
          if (bindings.length === 0) {
            builder.addReference(
              { name: moduleName.text, kind: "import", sourceNodeId: scope.parentNodeId },
              moduleName,
            );
          } else {
            for (const binding of bindings) {
              builder.addReference(
                {
                  name: moduleName.text,
                  kind: "import",
                  sourceNodeId: scope.parentNodeId,
                  localName: binding.localName,
                  importedName: binding.importedName,
                },
                moduleName,
              );
            }
          }
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
        const superclasses = node.childForFieldName("superclasses");
        if (superclasses !== null) {
          for (const target of superclasses.namedChildren) {
            const targetName = referenceTarget(target);
            if (targetName !== null) {
              builder.addReference(
                { name: targetName, kind: "extends", sourceNodeId: symbol.id },
                target,
              );
            }
          }
        }
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

        if (callable && right !== null && added[0] !== undefined) {
          const body = right.childForFieldName("body");
          if (body !== null) {
            visit(body, {
              parentNodeId: added[0].id,
              qualifiedName: added[0].node.qualifiedName ?? added[0].node.name,
              type: "function",
            });
          }
        } else if (right !== null) {
          visit(right, scope);
        }
        return added;
      }

      if (node.type === "call") {
        const callable = node.childForFieldName("function");
        const name = referenceTarget(callable);
        const args = callArguments(node);
        if (name !== null) {
          builder.addReference(
            { name, kind: "call", sourceNodeId: scope.parentNodeId },
            callable ?? node,
          );
        } else {
          builder.addReference(
            { name: "computed_callable", kind: "reflection", sourceNodeId: scope.parentNodeId },
            callable ?? node,
            {
              provenance: "dynamic",
              confidence: 0.25,
              metadata: { behavior: "computed_or_reflective_call" },
            },
          );
        }

        const method = name?.split(".").at(-1) ?? null;
        const addDynamicTarget = (
          argument: SyntaxNode | undefined,
          kind:
            | "callback"
            | "event_subscribe"
            | "queue_subscribe"
            | "dependency_injection"
            | "runtime_registration",
          behavior: string,
          confidence: number,
        ): void => {
          const target = referenceTarget(argument ?? null);
          if (target === null) return;
          builder.addReference(
            { name: target, kind, sourceNodeId: scope.parentNodeId },
            argument ?? node,
            {
              provenance: "dynamic",
              confidence,
              metadata: { behavior, registration_method: method },
            },
          );
        };
        if (name !== null && CALLBACK_CALLS.has(name)) {
          addDynamicTarget(args[0], "callback", "callback_invocation", 0.75);
        }
        if (method !== null && CALLBACK_METHODS.has(method)) {
          addDynamicTarget(args[0], "callback", "scheduled_callback", 0.7);
        }
        if (method !== null && EVENT_SUBSCRIBE_METHODS.has(method)) {
          addDynamicTarget(args.at(-1), "event_subscribe", "event_subscription", 0.7);
        }
        if (method !== null && QUEUE_SUBSCRIBE_METHODS.has(method)) {
          addDynamicTarget(args.at(-1), "queue_subscribe", "queue_consumer", 0.65);
        }
        if (method !== null && REGISTRATION_METHODS.has(method)) {
          addDynamicTarget(args.at(-1), "runtime_registration", "runtime_registration", 0.6);
        }
        if (name === "Depends" || method === "resolve" || method === "inject") {
          addDynamicTarget(args[0], "dependency_injection", "dependency_injection", 0.65);
        }
        if (method !== null && EVENT_PUBLISH_METHODS.has(method)) {
          builder.addReference(
            { name: "runtime_event_target", kind: "event_publish", sourceNodeId: scope.parentNodeId },
            args[0] ?? node,
            {
              provenance: "dynamic",
              confidence: 0.35,
              metadata: { behavior: "event_publish", publisher_method: method },
            },
          );
        }
        if (method !== null && QUEUE_PUBLISH_METHODS.has(method)) {
          builder.addReference(
            { name: "runtime_queue_target", kind: "queue_publish", sourceNodeId: scope.parentNodeId },
            args[0] ?? node,
            {
              provenance: "dynamic",
              confidence: 0.35,
              metadata: { behavior: "queue_publish", publisher_method: method },
            },
          );
        }
        if (name !== null && (REFLECTION_CALLS.has(name) || callable?.type === "subscript")) {
          builder.addReference(
            { name: "reflective_target", kind: "reflection", sourceNodeId: scope.parentNodeId },
            callable ?? node,
            {
              provenance: "dynamic",
              confidence: 0.2,
              metadata: { behavior: "reflection" },
            },
          );
        }
      }

      if (isValueReference(node)) {
        builder.addReference(
          { name: node.text, kind: "reference", sourceNodeId: scope.parentNodeId },
          node,
        );
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

    if (generated) {
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
    const result = builder.result();
    if (generated) {
      for (const node of result.nodes) {
        node.provenance = "dynamic";
        node.metadata.generated = true;
      }
      for (const edge of result.edges) {
        edge.provenance = "dynamic";
        edge.confidence = Math.min(edge.confidence, 0.9);
        edge.metadata.generated = true;
      }
    }
    return result;
  },
};
