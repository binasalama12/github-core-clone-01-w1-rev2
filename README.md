[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/binasalama12/github-core-clone-01-w1-rev2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/binasalama12/github-core-clone-01-w1-rev2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# Single-file forge, speed first

A GitHub-compatible git forge written from scratch in one TypeScript file
(`main.ts`), running on Node 22 with no dependencies and no git binary.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (`ls-refs`, `fetch` with shallow/deepen and side-band-64k) plus a v0
  fallback, and receive-pack v0 with report-status, per-ref
  fast-forward enforcement and mixed ok/ng reports.
- **REST v3** under `/api/v3` — repositories, branches, commits, the
  contents API, labels, issues + comments, and pull requests with files,
  diff counts and squash merges with conflict detection.
- **GraphQL v4** at `/api/graphql` — the queries and mutations `gh` and
  github-mcp-server send: viewer, repository fields, introspection for
  Issue / PullRequest / Repository / SearchType, issue and pull-request
  connections with cursor pagination, and the create/close/merge/comment
  mutations, with Relay-style global ids and batched operations.
- **MCP** at `/mcp` — JSON-RPC 2.0 streamable HTTP speaking the
  2026-07-28 revision (`server/discover`) and the legacy initialize
  handshake, with `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request` acting on the same store
  as REST.

Everything lives in memory (Maps keyed by repository); nothing persists
across restarts. The single user is `adaiversen`; requests authenticate
with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (an empty token accepts
all requests).

## Lifecycle

The process binds an ephemeral port, POSTs `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, polls `GET $MAKEFUN_ENV_URL/done` until the
suite answers `{"done": true}`, then exits 0.

## Why it is fast

- Pack ingest inflates each object with **one** `inflateSync(..., {info:
  true})` call and trusts the returned `engine.bytesWritten` as the
  consumed length — no length guessing, no re-inflation.
- Fast-forward checks are early-exit depth-first walks: the search stops
  the moment the ancestor is found.
- Each stored object is hashed exactly once, when it is stored; parsed
  commits, trees and flattened trees are cached by object id.
- Handlers do work proportional to the request — no whole-repo scans on
  hot paths (issue reads, pushes of a few objects, depth-1 clones).

## Run

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node main.ts
```
