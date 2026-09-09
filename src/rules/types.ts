import type { ArchitectureRule } from "../ir/models.js";

export interface DomainOverride {
  include: string[];
  exclude: string[];
}

export interface KnowledgeOwner {
  id: string;
  owner: string;
  purpose: string;
  include: string[];
  entrypoint: string | null;
  contracts: string[];
  validation_command: string | null;
}

export interface KnowledgeJourney {
  id: string;
  name: string;
  purpose: string;
  entrypoint: string;
}

export interface KnowledgeInvariant {
  id: string;
  statement: string;
  applies_to: string[];
}

export interface CanonicalName {
  symbol: string;
  name: string;
}

export interface KnowledgeConfig {
  owners: KnowledgeOwner[];
  journeys: KnowledgeJourney[];
  invariants: KnowledgeInvariant[];
  canonical_names: CanonicalName[];
  max_documentation_age_days: number;
}

export interface CodeAtlasV2Config {
  version: number;
  index: { exclude: string[] };
  domains: Record<string, DomainOverride>;
  architecture: { rules: ArchitectureRule[] };
  analysis: {
    max_call_depth: number;
    max_impact_depth: number;
  };
  html: { mode: "single-file" | "bundle"; max_single_file_bytes: number };
  ai: { enabled: boolean };
  knowledge: KnowledgeConfig;
}

export const DEFAULT_V2_CONFIG: CodeAtlasV2Config = {
  version: 1,
  index: { exclude: [] },
  domains: {},
  architecture: { rules: [] },
  analysis: { max_call_depth: 8, max_impact_depth: 10 },
  html: { mode: "single-file", max_single_file_bytes: 10 * 1024 * 1024 },
  ai: { enabled: false },
  knowledge: {
    owners: [],
    journeys: [],
    invariants: [],
    canonical_names: [],
    max_documentation_age_days: 180,
  },
};
