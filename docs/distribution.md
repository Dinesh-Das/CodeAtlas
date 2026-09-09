# Distribution and registry publication

CodeAtlas ships `server.json` for the official MCP Registry and the matching `mcpName` in
`package.json`. Versions, npm identity, repository identity, transport, compatibility coverage,
adapter gates, and pinned public-repository evidence are checked locally:

```bash
npm run distribution:check
```

The registry is currently in preview. Its npm ownership flow requires the npm package to be
published first, with the package `mcpName` exactly matching `server.json#name`. For a release:

1. Run `npm run release:check` and create the exact version tag.
2. The release workflow publishes the npm package and verifies its tarball checksum.
3. It downloads pinned `mcp-publisher` v1.7.9 and verifies the published archive checksum.
4. It validates `server.json`, authenticates with GitHub OIDC, and publishes the metadata.
5. It verifies the immutable version through the registry search API before completing.

Publication deliberately remains a maintainer-authenticated release action. GitHub OIDC avoids a
standing registry token, and tag protection controls who can start it. See the official
[MCP Registry quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)
and [registry repository](https://github.com/modelcontextprotocol/registry) for current preview
commands and schema policy.

The npm package includes `server.json`, `compatibility.json`, and copyable host examples. A release
must never edit only one version location: `distribution:check` rejects version or identity drift.
