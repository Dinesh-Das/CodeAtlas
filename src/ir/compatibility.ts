import { ATLAS_SCHEMA_VERSION, type Atlas } from "./models.js";
import { assertValidAtlas } from "./validation.js";

const LEGACY_ATLAS_SCHEMA_VERSIONS = new Set(["1.0", "1.1"]);
const EXECUTABLE_RELATIONSHIPS = new Set([
  "CALLS", "HANDLES", "TRIGGERS", "PUBLISHES", "SUBSCRIBES", "MAY_CONTINUE_TO",
  "APPLIES_HOOK", "PROTECTED_BY", "QUERIES", "UPDATES", "READS_FROM", "WRITES_TO",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function legacyProvenance(value: unknown): string {
  if (value === "GIT") return "git";
  if (value === "HEURISTIC" || value === "EMBEDDING") return "inferred";
  if (value === "LLM") return "documentation";
  return "verified";
}

/**
 * Upgrade persistent Atlas snapshots whose shape predates explicit evidence and
 * control-flow semantics. Current build artifacts are regenerated instead.
 */
export function loadCompatibleAtlasSnapshot(value: unknown): Atlas {
  if (!isRecord(value)) throw new Error("Invalid CodeAtlas IR: atlas must be an object");
  if (LEGACY_ATLAS_SCHEMA_VERSIONS.has(String(value.schema_version))) {
    const evidence = Array.isArray(value.evidence) ? value.evidence : [];
    for (const item of evidence) {
      if (!isRecord(item)) continue;
      if (typeof item.excerpt_status !== "string") {
        const excerpt = typeof item.excerpt === "string" ? item.excerpt : null;
        item.excerpt_status = excerpt === null
          ? "unavailable"
          : excerpt.endsWith("…") ? "truncated" : "complete";
      }
      if (!("file_content_hash" in item)) {
        item.file_content_hash = typeof item.content_hash === "string" ? item.content_hash : null;
      }
      if (!("range_content_hash" in item)) item.range_content_hash = null;
      item.resolution_issue_id = null;
    }
    const controlFlows = Array.isArray(value.control_flows) ? value.control_flows : [];
    for (const item of controlFlows) {
      if (!isRecord(item)) continue;
      if (typeof item.analysis_kind !== "string") item.analysis_kind = "source_order_legacy";
      if (!Array.isArray(item.supported_constructs)) item.supported_constructs = [];
      if (!Array.isArray(item.unsupported_constructs)) {
        item.unsupported_constructs = ["legacy_control_flow_semantics"];
      }
    }
    const symbols = Array.isArray(value.symbols) ? value.symbols : [];
    for (const item of symbols) {
      if (!isRecord(item)) continue;
      item.provenance_category = legacyProvenance(item.provenance);
    }
    const relationships = Array.isArray(value.relationships) ? value.relationships : [];
    for (const item of relationships) {
      if (!isRecord(item)) continue;
      item.provenance_category = legacyProvenance(item.provenance);
      const metadata = isRecord(item.metadata) ? item.metadata : {};
      const resolution = metadata.resolution;
      item.target_resolution = resolution === "exact" || resolution === "unique_candidate" || resolution === "ambiguous"
        ? resolution
        : item.provenance_category === "dynamic" ? "dynamic" : "exact";
      item.execution_semantics = !EXECUTABLE_RELATIONSHIPS.has(String(item.type))
        ? "not_applicable"
        : metadata.conditional === true ? "conditional"
        : metadata.conditional === false ? "unconditional" : "unknown";
    }
    value.resolution_issues = [];
    value.schema_version = ATLAS_SCHEMA_VERSION;
  }
  const atlas = value as unknown as Atlas;
  assertValidAtlas(atlas);
  return atlas;
}
