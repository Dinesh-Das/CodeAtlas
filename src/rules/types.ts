import type { ArchitectureRule } from "../ir/models.js";

export interface DomainOverride {
  include: string[];
  exclude: string[];
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
  html: { mode: "single-file" | "bundle" };
  ai: { enabled: boolean };
}

export const DEFAULT_V2_CONFIG: CodeAtlasV2Config = {
  version: 1,
  index: { exclude: [] },
  domains: {},
  architecture: { rules: [] },
  analysis: { max_call_depth: 8, max_impact_depth: 10 },
  html: { mode: "single-file" },
  ai: { enabled: false },
};
