# CLAUDE.md

Notes for coding agents working on gtr-mcp: a small TypeScript MCP server (stdio) that wraps
git-worktree-runner (`git gtr`) so AI agents can manage git worktrees through eight typed tools.
This file is about changing the server; [AGENTS.md](AGENTS.md) is the guide for agents that use it.
Every document is indexed in [docs/INDEX.md](docs/INDEX.md).

## Layout

- `src/index.ts`: stdio transport, startup check of `gtr` and the repository, tool dispatch and the
  `gtr-workflow` prompt.
- `src/gtr.ts`: the `gtr` subprocess wrapper (`runGtr`, `execFile` with argument arrays, 10 MiB
  output cap, per-call timeouts), output parsers and error classes.
- `src/tools/worktree.ts`: tool definitions, Zod input schemas, handlers, `makeHandlers`,
  `dispatchToolCall`.
- `src/ff-check.ts`: fitness function FF-1, run by `npm run check`.
- `src/__tests__/`: parser, schema, security and integration tests. The integration suite drives real
  `gtr` against a temporary repository and is skipped when `gtr` is not on PATH.

## Gate

CI (`.github/workflows/ci.yml`, job `build-test-lint`, `ubuntu-latest`, Node 20) runs, in order:

```sh
npm ci
npm run build        # tsc
npm run check        # FF-1: no shell execution in src/
# FF-3: the number of default worktree_* tools must not exceed 8
npm test             # vitest run
npm run typecheck    # tsc --noEmit
```

A docs-only PR (Markdown, `docs/`, licence, issue and PR templates) skips the job through the
`docs-scope` job in the same workflow; that block is canonical across the fleet and compared byte
for byte, so do not edit it here.

## Invariants that are easy to break

- **No shell, ever.** Subprocesses use `execFile` with argv arrays. `shell: true`, `execSync` and
  exec template strings fail FF-1. User-controlled values (branch names, paths) are argv elements.
- **Destructive tools need `confirm: true`, enforced in the Zod schema,** not in the handler:
  `worktree_remove` always, `worktree_clean` when `merged` or `closed` is set without `dry_run`.
- **The server exposes no trust tool and no exec tool.** Running `git gtr trust` is a human decision;
  `worktree_create` reports `hooks_ran: false` with a remediation message instead.
- **The server is cwd-bound.** No tool takes a `repo_path`; repository selection is the client's
  `cwd`. `GTR_BIN` and `--gtr-bin` only locate the binary.
- **The default tool set is at its ceiling of 8** (FF-3). A ninth `worktree_*` tool fails CI; adding
  one means revisiting the ceiling on purpose, in the workflow and in the README tables.
- **Every `gtr` call has a timeout** (`TIMEOUT_READ` 90 s for list, status, path and clean;
  `TIMEOUT_MODIFY` 120 s for create, rename, remove and copy; `GtrTimeoutError`); pass one when adding a tool.
- **Omitted MCP arguments are coalesced to `{}` at the dispatch seam** (`dispatchToolCall`), so a
  tool with no required fields works when the client sends no arguments.
- **Parsers read `gtr list --porcelain`** (tab-separated `path`, `branch`, `status`); a tab inside a
  branch or path corrupts it, a known gtr limitation. A `--json` mode in gtr would replace the
  regex parsing of `worktree_create` output.
- **Tool names, safety classes and schemas are mirrored in `README.md` and `AGENTS.md`;** change all
  three together.
- **This repository is public.** No hostnames, operator paths, account names, tokens or personal
  data in any tracked file, tests and fixtures included.
