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
npx gtr-mcp --repo-path /path/to/your/repo
```

### Global install

```bash
npm install -g gtr-mcp
gtr-mcp --repo-path /path/to/your/repo
```

### From source

```bash
git clone https://github.com/coderabbitai/gtr-mcp
cd gtr-mcp
npm install
npm run build
node dist/index.js --repo-path /path/to/your/repo
```

## MCP client configuration

### Claude Desktop / Claude Code

Add to `~/.claude/claude_desktop_config.json` or your project `.mcp.json`:

```json
{
  "mcpServers": {
    "gtr": {
      "command": "node",
      "args": ["/path/to/gtr-mcp/dist/index.js"],
      "env": {
        "GTR_MCP_REPO_PATH": "/path/to/your/repo"
      }
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
        "env": {
          "GTR_MCP_REPO_PATH": "/path/to/your/repo"
        }
      }
    }
  }
}
```

## Configuration

| Env var | CLI arg | Description |
|---------|---------|-------------|
| `GTR_MCP_REPO_PATH` | `--repo-path <path>` | Default repo path; callers can omit `repo_path` per call |
| `GTR_MCP_REPO_BASE` | `--repo-base <path>` | If set, all `repo_path` values must be under this directory |
| `GTR_BIN` | `--gtr-bin <path>` | Path to the gtr binary (default: `git gtr` via PATH) |
| `GTR_MCP_ENABLE_EXEC` | — | Set to `"1"` to expose the `worktree_exec` tool (off by default) |

## Tools

| Tool | Safety | Required params | Description |
|------|--------|-----------------|-------------|
| `worktree_list` | SAFE | `repo_path` | List all worktrees with path, branch, status |
| `worktree_status` | SAFE | `repo_path`, `branch` | Git status for a worktree (staged/unstaged/untracked, ahead/behind) |
| `worktree_path` | SAFE | `repo_path`, `branch` | Resolve a branch/identifier to its absolute filesystem path |
| `worktree_create` | MODIFY | `repo_path`, `branch` | Create a new worktree (and branch if needed) |
| `worktree_copy` | MODIFY | `repo_path`, `from` | Copy files (by glob pattern) from one worktree into others; use `dry_run: true` to preview |
| `worktree_rename` | MODIFY | `repo_path`, `old_branch`, `new_branch` | Rename a worktree and its branch atomically |
| `worktree_remove` | DESTRUCTIVE | `repo_path`, `branch`, `confirm: true` | Remove a worktree from disk and git registry |
| `worktree_clean` | MODIFY/DESTRUCTIVE | `repo_path` | Prune stale entries; `confirm: true` required with `merged`/`closed` |
| `worktree_exec` | MODIFY | `repo_path`, `branch`, `command` | Run a command inside a worktree (opt-in only) |

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

### Path restriction

Set `GTR_MCP_REPO_BASE` to prevent an agent from operating on arbitrary paths:

```bash
GTR_MCP_REPO_BASE=/Users/me/Developer gtr-mcp
```

Any `repo_path` outside the base is rejected before the gtr subprocess is invoked.

### Porcelain output (Gate-0 finding)

`gtr list --porcelain` outputs tab-separated `path\tbranch\tstatus` with **raw unescaped
values** — `list.sh` calls `_tsv_unescape_field` when reading stored records and then
prints raw via `printf`. No un-escape pass is needed on our side. A branch or path
containing a literal tab character would corrupt the TSV output — this is a known gtr
limitation, not a bug in this server.

## The exec tool opt-in

`worktree_exec` is disabled by default. Even when enabled, prefer your shell tool:

```bash
cd "$(git gtr go branch-name)" && your-command
```

`worktree_exec` adds an indirection layer with no safety benefit over your native shell.
Set `GTR_MCP_ENABLE_EXEC=1` only if your client cannot run shell commands directly.

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

### Startup validation — not a git repo

Each tool call validates `repo_path` via `git rev-parse --git-dir` before invoking gtr.
If you see `Not a git repository`, ensure the path points to a repo root (contains `.git`).

## Development

```bash
npm install
npm run build      # tsc compile
npm test           # vitest (parser + schema + integration if gtr available)
npm run lint       # tsc --noEmit type check
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
    worktree.ts          Tool definitions, schemas, handlers, dispatch table
  __tests__/
    parsers.test.ts      Parser unit tests (parsePorcelainList, parseGitStatus)
    schemas.test.ts      Schema validation tests (confirm gate, coercion)
    integration.test.ts  Live gtr integration tests (skipped if gtr not on PATH)
.github/
  workflows/
    ci.yml               CI: build + FF-1 + FF-3 + test + lint
AGENTS.md                AI agent usage guide
```
