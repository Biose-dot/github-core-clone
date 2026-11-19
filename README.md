# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Biose-dot/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Biose-dot/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in TypeScript on Node's standard library alone — no dependencies, no install step. Real git objects (SHA-1 blobs, trees, commits, tags) in one in-memory store sit behind four surfaces that all read the same data: git smart HTTP (protocol v0 and v2 advertisements, ls-refs, fetch with shallow/deepen, receive-pack with report-status), the REST v3 surface (repositories, branches, commits, contents, the Git Data API, labels, issues and comments, pull requests with files and three-way merges), a GraphQL v4 endpoint answering the documents gh and github-mcp-server send (viewer, repository, connections with cursor pagination, the create/close/merge mutations, node(id:), batching, __type introspection), and an MCP endpoint (server/discover plus the legacy handshake) whose tools create and read the very objects REST serves.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<trial token> node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL/register`, answers `/healthz`, and polls `$MAKEFUN_ENV_URL/done` until the trial ends. State is in-memory and deterministic: timestamps come from a fixed base plus a tick counter, so a replay produces the same bytes.

Layout: `main.ts` is the entry↔env lifecycle; `app.ts` re-exports the server; `src/core.ts` is the object store and domain model; `src/pack.ts` packfile read/write; `src/git.ts` smart HTTP; `src/rest.ts` REST v3; `src/graphql.ts` the GraphQL executor; `src/mcp.ts` the MCP endpoint; `src/server.ts` routing and auth.

---
<sub>Entered on [make.fun](https://make.fun/?ref=z5jb9v24&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
