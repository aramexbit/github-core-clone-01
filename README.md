# github-core-clone-01

A GitHub-compatible forge in one Node 22 stdlib-only process (no dependencies, no git
binary, no internet at grading): REST v3 (repos, branches, commits, contents, issues,
comments, labels, pull requests, merges), git smart HTTP (upload-pack / receive-pack,
protocol v0 + v2, real packfiles, shallow fetch, non-fast-forward protection), GraphQL
v4 (viewer, repository, issues, pull requests, mutations, introspection, batched
documents) and an MCP endpoint (server/discover, initialize, tools/list, tools/call).

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle (bind an ephemeral port, register it with
`$MAKEFUN_ENV_URL`, poll `/done`, exit 0); `app.ts` is the whole forge. The store is
in-memory: one trial is one process, and the suite seeds every fixture through the API.

## Layout

- `main.ts` — entry lifecycle (unchanged from the starter).
- `app.ts` — the forge: scenario identity, git object store + packfiles, REST, git smart
  HTTP, GraphQL, MCP.
- `package.json`, `tsconfig.json` — starter metadata (Node 22, type-stripping).
- `.makefun/owner.json` — the entry owner's wallet.
