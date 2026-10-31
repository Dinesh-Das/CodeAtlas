import { CodeAtlasError } from "../core/errors.js";
import type { ChangeContext } from "./packet.js";

export const COMPACT_CONTEXT_FORMAT = "codeatlas.compact.v1" as const;

export interface CompactChangeContext {
  format: typeof COMPACT_CONTEXT_FORMAT;
  instructions: string;
  ids: Record<string, string>;
  files: Record<string, string>;
  symbols: Record<string, unknown>;
  context: Record<string, unknown>;
}

const idField = (key: string): boolean => key === "id" || key.endsWith("_id") || key.endsWith("_ids");
const fileField = (key: string): boolean => key === "file" || key === "source_file";
const tableFields = new Set([
  "change_candidates", "edit_locations", "verified_paths", "potential_paths", "supporting_paths",
  "relevant_flows", "affected_contracts", "relevant_tests", "constraints", "invariants",
  "validation_commands", "verification_checklist", "evidence", "gaps",
]);

/** Normalize structure only. Task text, commands, names, and source remain literal data. */
export function compactChangeContext(packet: ChangeContext): CompactChangeContext {
  const ids: Record<string, string> = {};
  const files: Record<string, string> = {};
  const symbols: Record<string, unknown> = {};
  const idAliases = new Map<string, string>();
  const fileAliases = new Map<string, string>();
  const symbolAliases = new Map<string, string>();
  const intern = (value: string, table: Record<string, string>, aliases: Map<string, string>, prefix: string): string => {
    const existing = aliases.get(value);
    if (existing !== undefined) return existing;
    const alias = `${prefix}${aliases.size + 1}`;
    aliases.set(value, alias);
    table[alias] = value;
    return alias;
  };
  const symbolReference = (value: unknown): string => {
    const serialized = JSON.stringify(value);
    const existing = symbolAliases.get(serialized);
    if (existing !== undefined) return existing;
    const alias = `s${symbolAliases.size + 1}`;
    symbolAliases.set(serialized, alias);
    symbols[alias] = visit(value);
    return alias;
  };
  const visit = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (idField(key)) return intern(value, ids, idAliases, "i");
      if (fileField(key)) return intern(value, files, fileAliases, "f");
      return value;
    }
    if (Array.isArray(value)) {
      if (key === "path_symbols") return value.map(symbolReference);
      const items = value.map((item) => visit(item, key));
      if (tableFields.has(key) && items.length >= (key === "evidence" ? 1 : 2) &&
          items.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
        const records = items as Record<string, unknown>[];
        const columns = Object.keys(records[0]!);
        if (records.every((record) => JSON.stringify(Object.keys(record)) === JSON.stringify(columns))) {
          return { columns, rows: records.map((record) => columns.map((column) => record[column])) };
        }
      }
      return items;
    }
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) =>
      childKey === "symbol" && child !== null && typeof child === "object"
        ? ["symbol_ref", symbolReference(child)]
        : [childKey, visit(child, childKey)]
    ));
  };
  const context = visit(packet) as Record<string, unknown>;
  return {
    format: COMPACT_CONTEXT_FORMAT,
    instructions: "Tables use columns and rows. Expand symbol_ref with symbols, ID fields with ids, and file/source_file with files. Aliases are response-local; use full IDs for MCP. Deferred source requires get_evidence.",
    ids, files, symbols, context,
  };
}

/** Expand a compact packet into its original context; missing references fail closed. */
export function expandCompactContext(packet: CompactChangeContext): ChangeContext {
  const invalid = (reference: string): never => {
    throw new CodeAtlasError(`Invalid compact context reference: ${reference}.`, { code: "invalid_context_packet", recoverable: false });
  };
  if (packet.format !== COMPACT_CONTEXT_FORMAT) invalid("format");
  const lookup = (table: Record<string, unknown>, alias: string): unknown =>
    Object.hasOwn(table, alias) ? table[alias] : invalid(alias);
  const resolvingSymbols = new Set<string>();
  const expandSymbol = (alias: string): unknown => {
    if (resolvingSymbols.has(alias)) invalid(alias);
    resolvingSymbols.add(alias);
    const symbol = visit(lookup(packet.symbols, alias));
    resolvingSymbols.delete(alias);
    return symbol;
  };
  const visit = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (idField(key)) return lookup(packet.ids, value);
      if (fileField(key)) return lookup(packet.files, value);
      return value;
    }
    if (Array.isArray(value)) {
      return key === "path_symbols"
        ? value.map((alias) => expandSymbol(String(alias)))
        : value.map((item) => visit(item, typeof item === "string" ? key : ""));
    }
    if (value === null || typeof value !== "object") return value;
    if (tableFields.has(key)) {
      const { columns, rows } = value as { columns: unknown; rows: unknown };
      if (!Array.isArray(columns) || !columns.every((column) => typeof column === "string") ||
          new Set(columns).size !== columns.length || !Array.isArray(rows) ||
          !rows.every((row) => Array.isArray(row) && row.length === columns.length)) invalid("table");
      return (rows as unknown[][]).map((row) => visit(Object.fromEntries(
        (columns as string[]).map((column, index) => [column, row[index]])
      )));
    }
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) =>
      childKey === "symbol_ref" && typeof child === "string"
        ? ["symbol", expandSymbol(child)]
        : [childKey, visit(child, childKey)]
    ));
  };
  return visit(packet.context) as ChangeContext;
}
