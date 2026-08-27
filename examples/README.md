# MCP client example

Install CodeAtlas globally, initialize the Git repository, and copy the `codeatlas` server entry
from `mcp-config.json` into the MCP configuration used by your coding agent. Replace the example
repository path with an absolute path to the repository you initialized.

```bash
npm install --global @dinesh-das/codeatlas
cd /absolute/path/to/repository
codeatlas init
```

The MCP host should start this local stdio process:

```bash
codeatlas mcp /absolute/path/to/repository
```

No daemon, Docker container, API key, cloud account, or network service is required. CodeAtlas
automatically synchronizes uncommitted working-tree changes before answering each MCP request.
