# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aramexbit/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aramexbit/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge in one Node 22 stdlib-only process (no dependencies, no git
binary, no internet at grading): REST v3 (repos, branches, commits, contents, issues,
comments, labels, pull requests, merges), git smart HTTP (upload-pack / receive-pack,
protocol v0 + v2, real packfiles, shallow fetch, non-fast-forward protection), GraphQL
v4 (viewer, repository, issues, pull requests, mutations, introspection, batched
documents) and an MCP endpoint (server/discover, initialize, tools/list, tools/call).

This is a full rewrite written in a fresh post-open session (v2). It reproduces the
behaviour of the v1 entry from the specification — the kit's RULES, practice tests and
check sources — not from the v1 sources.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle (bind an ephemeral port, register it with
`$MAKEFUN_ENV_URL`, poll `/done`, exit 0); `app.ts` is the whole forge. The store is
in-memory: one trial is one process, and the suite seeds every fixture through the API.

## Layout

- `main.ts` — entry lifecycle, written fresh for this rebuild.
- `app.ts` — the forge: scenario identity, git object store + packfiles, REST, git smart
  HTTP, GraphQL, MCP.
- `package.json`, `tsconfig.json` — Node 22, type-stripping, strict.
- `.makefun/owner.json` — the entry owner's wallet.

## Notes on the trickier behaviour

- ls-refs (v2) answers one line per ref, with `peeled:` on the same line for annotated
  tags; an empty repository answers no ref lines at all.
- Shallow fetch sends the requested commits plus their tree closures only, and the
  held-set computation stops at the client's shallow boundaries, so a deepen past a
  boundary still delivers the parents.
- Commit JSON strips one trailing newline from the message, the way GitHub renders it.
- Packs are written without deltas; the reader handles plain, ofs-delta and ref-delta
  entries, which is what pushes from real git clients carry.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rrcbfccn&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
