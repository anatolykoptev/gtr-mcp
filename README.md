# gtr-mcp

An MCP (Model Context Protocol) server that wraps [git-worktree-runner](https://github.com/coderabbitai/git-worktree-runner) (`gtr`) so AI agents can manage git worktrees through a structured, safe tool interface.

Built as a contribution to [issue #67](https://github.com/coderabbitai/git-worktree-runner/issues/67).

## Prerequisites

- Node.js 18+
- `git gtr` installed and on PATH (see [gtr install docs](https://github.com/coderabbitai/git-worktree-runner#installation)) — or set `GTR_BIN`
- The repos you want to manage must have `git` initialized

## Install

### Via npx (no install)

```bash
cd /path/to/your/repo
npx gtr-mcp
```

### Global install

```bash
npm install -g gtr-mcp
cd /path/to/your/repo
gtr-mcp
```

### From source

```bash
git clone https://github.com/coderabbitai/gtr-mcp
cd gtr-mcp
npm install
npm run build
cd /path/to/your/repo
node /path/to/gtr-mcp/dist/index.js
```

## How it works

gtr-mcp operates on the git repository at the **working directory it is launched in**.
Set your MCP client's `cwd` field to the repository root. One server instance = one repo context.
Multi-repo: add a separate MCP server entry per repo in your client config, each with its own `cwd`.

This mirrors how gtr itself works — `git gtr` discovers its repo from the current directory
via `git rev-parse --git-common-dir`, with no path argument required.

## MCP client configuration

### Claude Desktop / Claude Code

Add to `~/.claude/claude_desktop_config.json` or your project `.mcp.json`:

```json
{
  "mcpServers": {
    "gtr": {
      "command": "npx",
      "args": ["gtr-mcp"],
      "cwd": "/path/to/your/repo"
    }
  }
}
```

### Cursor

```json
{
  "mcp": {
    "servers": {
      "gtr": {
        "command": "npx",
        "args": ["gtr-mcp"],
        "cwd": "/path/to/your/repo"
      }
    }
  }
}
```

### Multi-repo setup

```json
{
  "mcpServers": {
    "gtr-frontend": {
      "command": "npx",
      "args": ["gtr-mcp"],
      "cwd": "/path/to/frontend"
    },
    "gtr-backend": {
      "command": "npx",
      "args": ["gtr-mcp"],
      "cwd": "/path/to/backend"
    }
  }
}
```

## Configuration

| Env var | CLI arg | Description |
|---------|---------|-------------|
| `GTR_BIN` | `--gtr-bin <path>` | Path to the gtr binary (default: `git gtr` via PATH). Binary locator only — not a repo selector. |

The `cwd` field in your MCP client config is the only repo-selection mechanism.

## Tools

| Tool | Safety | Required params | Description |
|------|--------|-----------------|-------------|
| `worktree_list` | SAFE | — | List all worktrees with path, branch, status |
| `worktree_status` | SAFE | `branch` | Git status for a worktree (staged/unstaged/untracked, ahead/behind) |
| `worktree_path` | SAFE | `branch` | Resolve a branch/identifier to its absolute filesystem path |
| `worktree_create` | MODIFY | `branch` | Create a new worktree (and branch if needed) |
| `worktree_copy` | MODIFY | `from` | Copy files (by glob pattern) from one worktree into others; use `dry_run: true` to preview |
| `worktree_rename` | MODIFY | `old_branch`, `new_branch` | Rename a worktree and its branch atomically |
| `worktree_remove` | DESTRUCTIVE | `branch`, `confirm: true` | Remove a worktree from disk and git registry |
| `worktree_clean` | MODIFY/DESTRUCTIVE | — | Prune stale entries; `confirm: true` required with `merged`/`closed` |

No tool accepts a `repo_path` argument. The server is cwd-bound.

### Safety model

- **SAFE** — read-only. Can run freely.
- **MODIFY** — creates or rearranges state. Reversible with normal git operations.
- **DESTRUCTIVE** — removes state from disk and/or git registry. Requires `confirm: true` explicitly.

### Confirm gate

`worktree_remove` always requires `confirm: true`. `worktree_clean` with `merged: true` or
`closed: true` (without `dry_run: true`) also requires `confirm: true`. This is Zod-schema
enforced — the gate cannot be bypassed by an agent that infers the wrong intent.

`worktree_copy` does not require a confirm gate: it is file-copy only (wraps `gtr copy`, which
uses `cp` internally). It overwrites matching files in the target but cannot delete your
pre-existing files — gtr's only directory-prune paths act on freshly-copied trees under the
repo's own trusted `.gtrconfig`, never on existing target files. Use `dry_run: true` to preview
before committing a real copy.

## Security notes

### No shell execution

All subprocess calls use `execFile` with argument arrays — never `shell: true`, never
string interpolation into a shell command. User-controlled values (branch names, paths)
are passed as argv elements, not shell tokens.

### Trust boundary

gtr's `.gtrconfig` `postCreate` hooks only execute if a **human** previously ran
`git gtr trust` in the repository. An agent cannot enable trust — the server exposes
no trust tool. If `worktree_create` returns `hooks_ran: false`, a remediation message
is included telling the human what to run.

### Porcelain output (Gate-0 finding)

`gtr list --porcelain` outputs tab-separated `path\tbranch\tstatus` with **raw unescaped
values** — `list.sh` calls `_tsv_unescape_field` when reading stored records and then
prints raw via `printf`. No un-escape pass is needed on our side. A branch or path
containing a literal tab character would corrupt the TSV output — this is a known gtr
limitation, not a bug in this server.

## Prompts

The server exposes a `gtr-workflow` prompt with a markdown guide covering:
- When to use worktrees
- The standard create → work → status → remove loop
- Safety contract and trust model
- Path resolution behaviour

Fetch it via `prompts/get` with `name: "gtr-workflow"`.

## Troubleshooting

### gtr not found

```
gtr-mcp startup failed: gtr not found (tried "git gtr")
```

Install gtr: https://github.com/coderabbitai/git-worktree-runner#installation

Or point at the binary directly:

```bash
GTR_BIN=/path/to/gtr gtr-mcp
```

### Hooks skipped

If `worktree_create` returns `"hooks_ran": false`, the repository is not trusted. Have a
human run `git gtr trust` in the repo root.

### `worktree_clean --merged` fails (gh/glab not found)

The `merged` and `closed` flags require the GitHub CLI (`gh`) or GitLab CLI (`glab`) to be
installed and authenticated. Install them and run `gh auth login` first.

### Startup warning — not a git repo

```
gtr-mcp warning: "/some/path" is not a git repository. ...
```

The server started but the `cwd` is not a git repository. Set the MCP client's `cwd` field
to the repository root (the directory containing `.git`).

## Development

```bash
npm install
npm run build      # tsc compile
npm test           # vitest (parser + schema + integration if gtr available)
npm run typecheck  # tsc --noEmit type check
npm run check      # FF-1: grep for shell execution patterns
```

## Roadmap

- **PR2**: gtr `--json` mode would remove regex parsing fragility for `worktree_create` output (tracking worktree_path and hook state).
- Go binary distribution: a single static binary via `go-mcpserver` for simpler install.

## File structure

```
src/
  index.ts               MCP server entry point, transport, dispatcher, prompts
  gtr.ts                 gtr subprocess wrapper, parsers, validators
  ff-check.ts            FF-1 fitness function (CI helper)
  tools/
    worktree.ts          Tool definitions, schemas, handlers, makeHandlers factory
  __tests__/
    parsers.test.ts      Parser unit tests (parsePorcelainList, parseGitStatus)
    schemas.test.ts      Schema validation tests (confirm gate, coercion, cwd model)
    integration.test.ts  Live gtr integration tests (skipped if gtr not on PATH)
.github/
  workflows/
    ci.yml               CI: build + FF-1 + FF-3 + test + lint
AGENTS.md                AI agent usage guide
```
