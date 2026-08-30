import picomatch from "picomatch";
import { sha256 } from "../core/hashing.js";
import type { Atlas, AtlasDomain, AtlasSymbol } from "../ir/models.js";
import type { CodeAtlasV2Config } from "./types.js";

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "domain";
}

export function applyDomainOverrides(atlas: Atlas, config: CodeAtlasV2Config): void {
  const overrides = Object.entries(config.domains);
  if (overrides.length === 0) return;
  const symbolById = new Map(atlas.symbols.map((symbol) => [symbol.id, symbol]));
  for (const [name, override] of overrides) {
    const includes = override.include.map((pattern) => picomatch(pattern));
    const excludes = override.exclude.map((pattern) => picomatch(pattern));
    const matches = (symbol: AtlasSymbol): boolean => symbol.file !== null &&
      includes.some((match) => match(symbol.file!)) && !excludes.some((match) => match(symbol.file!));
    const memberIds = atlas.symbols.filter(matches).map((symbol) => symbol.id);
    if (memberIds.length === 0) continue;
    let domain = atlas.domains.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (domain === undefined) {
      const id = `domain:${slug(name)}`;
      const domainSymbol: AtlasSymbol = {
        id,
        kind: "domain",
        name,
        qualified_name: name,
        file: null,
        language: null,
        location: null,
        domain_ids: [],
        visibility: null,
        signature: null,
        content_hash: null,
        confidence: 1,
        provenance: "USER_DEFINED",
        fact_class: "INFERRED",
        evidence_ids: [],
        metadata: { override: true },
      };
      atlas.symbols.push(domainSymbol);
      symbolById.set(id, domainSymbol);
      domain = {
        id,
        name,
        member_ids: [],
        file_ids: [],
        entrypoint_ids: [],
        internal_relationship_ids: [],
        outgoing_relationship_ids: [],
        confidence: 1,
        label_provenance: "USER_DEFINED",
        evidence_ids: [],
      } satisfies AtlasDomain;
      atlas.domains.push(domain);
    }
    const moved = new Set(memberIds);
    for (const current of atlas.domains) {
      if (current.id === domain.id) continue;
      current.member_ids = current.member_ids.filter((id) => !moved.has(id));
      current.file_ids = current.file_ids.filter((id) => !moved.has(id));
      current.entrypoint_ids = current.entrypoint_ids.filter((id) => !moved.has(id));
    }
    for (const symbol of atlas.symbols) {
      if (moved.has(symbol.id)) symbol.domain_ids = [domain.id];
    }
    domain.member_ids = memberIds;
    domain.file_ids = memberIds.filter((id) => symbolById.get(id)?.kind === "file");
    domain.entrypoint_ids = memberIds.filter((id) => atlas.entrypoint_ids.includes(id));
    domain.confidence = 1;
    domain.label_provenance = "USER_DEFINED";
    atlas.relationships = atlas.relationships.filter((edge) =>
      !(edge.type === "BELONGS_TO_DOMAIN" && moved.has(edge.source)),
    );
    for (const memberId of memberIds) {
      atlas.relationships.push({
        id: `relationship:${sha256(`${memberId}:BELONGS_TO_DOMAIN:${domain.id}`)}`,
        source: memberId,
        target: domain.id,
        type: "BELONGS_TO_DOMAIN",
        confidence: 1,
        provenance: "USER_DEFINED",
        fact_class: "INFERRED",
        evidence_ids: [],
        metadata: { configured_domain: name },
      });
    }
  }
  const relationshipIds = new Set(atlas.relationships.map((edge) => edge.id));
  atlas.evidence = atlas.evidence.filter((item) =>
    item.relationship_id === null || relationshipIds.has(item.relationship_id),
  );
}
