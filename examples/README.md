# MCP client example

Install CodeAtlas globally, initialize the Git repository, and let setup configure a detected
Codex, Claude Code, Cursor, or Antigravity client:

```bash
npm install --global @dinesh-das/codeatlas
cd /absolute/path/to/repository
codeatlas init
codeatlas overview
codeatlas setup
```

Use `codeatlas setup --all --dry-run` to preview every supported destination. Setup preserves
unrelated servers and refuses to overwrite a conflicting `codeatlas` entry.

For another MCP-compatible host, copy the `codeatlas` server entry from `mcp-config.json` and
replace the example repository path with an absolute path to the repository you initialized.

The MCP host should start this local stdio process:

```bash
codeatlas mcp /absolute/path/to/repository
```

No daemon, Docker container, API key, cloud account, or network service is required. CodeAtlas
automatically synchronizes uncommitted working-tree changes before answering each MCP request.
