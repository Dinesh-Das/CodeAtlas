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

const CALLBACK_METHODS = new Set([
  "catch",
  "filter",
  "finally",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "setImmediate",
  "setInterval",
  "setTimeout",
  "some",
  "then",
]);
const EVENT_SUBSCRIBE_METHODS = new Set([
  "addEventListener",
  "addListener",
  "on",
  "once",
  "subscribe",
]);
const QUEUE_SUBSCRIBE_METHODS = new Set(["consume", "process", "worker"]);
const EVENT_PUBLISH_METHODS = new Set(["dispatch", "dispatchEvent", "emit"]);
const QUEUE_PUBLISH_METHODS = new Set([
  "addJob",
  "enqueue",
  "publish",
  "sendToQueue",
]);
const REGISTRATION_METHODS = new Set(["bind", "provide", "register", "registerHandler"]);
const REFLECTION_CALLS = new Set(["eval", "Function", "Reflect", "Proxy"]);

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

function referenceTarget(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  const direct = validName(node);
  if (direct !== null) return direct;
  if (node.type === "this" || node.type === "super") return node.type;
  if (node.type === "generic_type") {
    return referenceTarget(node.childForFieldName("name"));
  }
  if (node.type === "member_expression" || node.type === "nested_type_identifier") {
    const object = referenceTarget(
      node.childForFieldName("object") ?? node.childForFieldName("module"),
    );
    const property = validName(
      node.childForFieldName("property") ?? node.childForFieldName("name"),
    );
    return object === null || property === null ? null : `${object}.${property}`;
  }
  return null;
}

function memberParts(node: SyntaxNode | null): { object: string | null; method: string | null } {
  if (node === null || node.type !== "member_expression") {
    return { object: null, method: validName(node) };
  }
  return {
    object: referenceTarget(node.childForFieldName("object")),
    method: validName(node.childForFieldName("property")),
  };
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

function addImportReferences(
  builder: ParseGraphBuilder,
  statement: SyntaxNode,
  source: SyntaxNode,
  moduleName: string,
  sourceNodeId: string,
): void {
  const clause = statement.namedChildren.find((child) => child.type === "import_clause");
  if (clause === undefined) {
    builder.addReference({ name: moduleName, kind: "import", sourceNodeId }, source);
    return;
  }

  let added = false;
  for (const child of clause.namedChildren) {
    if (child.type === "identifier") {
      builder.addReference(
        { name: moduleName, kind: "import", sourceNodeId, localName: child.text, importedName: "default" },
        source,
      );
      added = true;
    } else if (child.type === "namespace_import") {
      const localName = validName(child.namedChildren.at(-1) ?? null);
      if (localName !== null) {
        builder.addReference(
          { name: moduleName, kind: "import", sourceNodeId, localName, importedName: "*" },
          source,
        );
        added = true;
      }
    } else if (child.type === "named_imports") {
      for (const specifier of child.namedChildren.filter(
        (candidate) => candidate.type === "import_specifier",
      )) {
        const importedName = validName(specifier.childForFieldName("name"));
        const localName = validName(specifier.childForFieldName("alias")) ?? importedName;
        if (importedName !== null && localName !== null) {
          builder.addReference(
            { name: moduleName, kind: "import", sourceNodeId, localName, importedName },
            source,
          );
          added = true;
        }
      }
    }
  }
  if (!added) builder.addReference({ name: moduleName, kind: "import", sourceNodeId }, source);
}

function isValueReference(node: SyntaxNode): boolean {
  if (node.type !== "identifier") return false;
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.childForFieldName("name")?.id === node.id) return false;
  if (parent.childForFieldName("property")?.id === node.id) return false;
  if (parent.childForFieldName("function")?.id === node.id) return false;
  return ![
    "import_clause",
    "import_specifier",
    "namespace_import",
    "export_specifier",
    "required_parameter",
    "optional_parameter",
    "type_annotation",
    "predefined_type",
  ].includes(parent.type);
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
    const generated = generatedSource(input);
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
        if (name !== null) {
          addImportReferences(builder, node, source ?? node, name, scope.parentNodeId);
        }
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
        const heritage = node.namedChildren.find((child) => child.type === "class_heritage");
        if (heritage !== undefined) {
          for (const clause of heritage.namedChildren) {
            const kind = clause.type === "implements_clause" ? "implements" : "extends";
            for (const target of clause.namedChildren) {
              const name = referenceTarget(target.childForFieldName("value") ?? target);
              if (name !== null) {
                builder.addReference({ name, kind, sourceNodeId: symbol.id }, target);
              }
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
        const heritage = node.namedChildren.find(
          (child) => child.type === "extends_type_clause",
        );
        if (heritage !== undefined) {
          for (const target of heritage.childrenForFieldName("type")) {
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
            if (body.type === "statement_block") {
              for (const child of body.namedChildren) visit(child, functionScope);
            } else {
              visit(body, functionScope);
            }
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
        const { object, method } = memberParts(callable);
        const args = callArguments(node);
        if (callable?.text === "require" || callable?.type === "import") {
          const argument = node.childForFieldName("arguments")?.namedChildren[0] ?? null;
          const name = stringValue(argument);
          if (name !== null) {
            const declarator = node.parent?.type === "variable_declarator" ? node.parent : null;
            const bindings = callable.text === "require"
              ? collectBindingNames(declarator?.childForFieldName("name") ?? null)
              : [];
            if (bindings.length === 0) {
              builder.addReference(
                { name, kind: "import", sourceNodeId: scope.parentNodeId },
                argument ?? node,
              );
            } else {
              const namespaceBinding = declarator?.childForFieldName("name")?.type === "identifier";
              for (const localName of bindings) {
                builder.addReference(
                  {
                    name,
                    kind: "import",
                    sourceNodeId: scope.parentNodeId,
                    localName,
                    importedName: namespaceBinding ? "*" : localName,
                  },
                  argument ?? node,
                );
              }
            }
          }
        } else {
          const name = referenceTarget(callable);
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

          if (method !== null && CALLBACK_METHODS.has(method)) {
            addDynamicTarget(args[0], "callback", "callback_invocation", 0.75);
          }
          if (callable?.type === "identifier" && CALLBACK_METHODS.has(callable.text)) {
            addDynamicTarget(args[0], "callback", "scheduled_callback", 0.75);
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
          if (
            method === "resolve" ||
            method === "inject" ||
            (method === "get" && /(?:container|injector|provider|services?)/iu.test(object ?? ""))
          ) {
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
          if (
            REFLECTION_CALLS.has(callable?.text ?? "") ||
            object === "Reflect" ||
            callable?.type === "subscript_expression"
          ) {
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
      }

      if (node.type === "new_expression") {
        const constructor = node.childForFieldName("constructor");
        const name = referenceTarget(constructor);
        if (name !== null) {
          builder.addReference(
            { name, kind: "call", sourceNodeId: scope.parentNodeId },
            constructor ?? node,
          );
        }
      }

      if (node.type === "assignment_expression") {
        const left = node.childForFieldName("left")?.text;
        const rightName = validName(node.childForFieldName("right"));
        if (rightName !== null && (left === "module.exports" || left?.startsWith("exports.") === true)) {
          pendingExports.push({ localName: rightName, syntaxNode: node });
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
  }
}
