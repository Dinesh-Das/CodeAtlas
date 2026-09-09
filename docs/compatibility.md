# MCP host compatibility

The machine-readable source of this matrix is `compatibility.json`. “Configuration tested” means
the stdio payload and CodeAtlas capability class are exercised by repository tests. Every host
still needs a live smoke run for each release.

| Host | One-command target | Tools | Resources | Prompts | Status |
|---|---|---:|---:|---:|---|
| Codex | `codeatlas setup --target codex` | Yes | Yes | Yes | Configuration tested |
| Claude Code | `codeatlas setup --target claude` | Yes | Yes | Yes | Configuration tested |
| Cursor | `codeatlas setup --target cursor` | Yes | Yes | Yes | Configuration tested |
| VS Code | `codeatlas setup --target vscode` | Yes | Yes | Yes | Configuration tested |
| GitHub Copilot coding agent | `codeatlas setup --target copilot` | Yes | No | No | Configuration tested |
| Antigravity | `codeatlas setup --target antigravity` | Yes | Yes | Yes | Configuration tested |

Copilot setup writes `.codeatlas/agent/copilot-mcp.json`; a repository administrator copies that
payload into the repository's coding-agent MCP settings. GitHub's hosted coding agent and code
review currently use MCP tools, while resources and prompts are not available there. Keep its tool
allowlist read-only. See GitHub's
[repository MCP configuration guide](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers).

VS Code setup merges a `codeatlas` entry into `.vscode/mcp.json` under `servers` and preserves
unrelated servers. See the official [VS Code MCP guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

CI runs the full checks on Windows, macOS, and Linux with the supported Node release lines. Host UI
versions change independently, so update `lastVerified` only after rerunning the corresponding
smoke test; do not infer support from a shared JSON shape.
