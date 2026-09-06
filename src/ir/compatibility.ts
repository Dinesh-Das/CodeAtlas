import { ATLAS_SCHEMA_VERSION, type Atlas } from "./models.js";
import { assertValidAtlas } from "./validation.js";

const LEGACY_ATLAS_SCHEMA_VERSION = "1.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Upgrade persistent Atlas snapshots whose shape predates explicit evidence and
 * control-flow semantics. Current build artifacts are regenerated instead.
 */
export function loadCompatibleAtlasSnapshot(value: unknown): Atlas {
  if (!isRecord(value)) throw new Error("Invalid CodeAtlas IR: atlas must be an object");
  if (value.schema_version === LEGACY_ATLAS_SCHEMA_VERSION) {
    const evidence = Array.isArray(value.evidence) ? value.evidence : [];
    for (const item of evidence) {
      if (!isRecord(item)) continue;
      const excerpt = typeof item.excerpt === "string" ? item.excerpt : null;
      item.excerpt_status = excerpt === null
        ? "unavailable"
        : excerpt.endsWith("…") ? "truncated" : "complete";
      item.file_content_hash = typeof item.content_hash === "string" ? item.content_hash : null;
      item.range_content_hash = null;
    }
    const controlFlows = Array.isArray(value.control_flows) ? value.control_flows : [];
    for (const item of controlFlows) {
      if (!isRecord(item)) continue;
      item.analysis_kind = "source_order_legacy";
      item.supported_constructs = [];
      item.unsupported_constructs = ["legacy_control_flow_semantics"];
    }
    value.schema_version = ATLAS_SCHEMA_VERSION;
  }
  const atlas = value as unknown as Atlas;
  assertValidAtlas(atlas);
  return atlas;
}
