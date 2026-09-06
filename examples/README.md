# MCP client example

Install CodeAtlas globally, build the repository map, and let setup configure a detected
Codex, Claude Code, Cursor, or Antigravity client:

```bash
npm install --global @dinesh-das/codeatlas
cd /absolute/path/to/repository
codeatlas build .
codeatlas overview
codeatlas setup
```

Use `codeatlas setup --all --dry-run` to preview every supported destination. Setup preserves
unrelated servers and refuses to overwrite a conflicting `codeatlas` entry.

For another MCP-compatible host, copy the `codeatlas` server entry from `mcp-config.json` and
replace the example repository path with an absolute path to the repository you built.

The MCP host should start this local stdio process:

```bash
codeatlas mcp /absolute/path/to/repository
```

No daemon, Docker container, API key, cloud account, or network service is required. CodeAtlas
automatically synchronizes working-tree changes before answering each MCP request. Git is optional
for basic indexing, but history, commit diffs, and rename provenance require a Git repository.
