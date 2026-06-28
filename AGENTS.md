# gtr Worktree Agent Guide

This file teaches AI agents when and how to use git worktrees via the `gtr-mcp` MCP server.
Import it into your project's AGENTS.md or reference it in your system prompt.

## Repo context

gtr-mcp operates on the git repository at the working directory it was launched in.
**You do not pass a `repo_path` to any tool.** The server is cwd-bound; the operator
sets the correct repository by configuring the MCP client's `cwd` field.

## When to use a worktree

Use `worktree_create` when:

- **Another agent holds main**: a parallel agent is running tests or a deploy on the main
  checkout; you need to work without stepping on it
- **Risky refactor**: you want to make sweeping changes you might abandon; a worktree lets
  you switch back to main cleanly without stashing or reverting
- **Parallel feature work**: two independent features can progress simultaneously in separate
  worktrees without branch-switching overhead
- **PR review**: check out a PR branch in a worktree while your main branch stays at HEAD

Do NOT create a worktree for quick one-file edits — just work on the branch directly.

## The standard loop

```
worktree_list          → see what exists (source of truth, not agent memory)
worktree_create        → spin up a new worktree
  (work happens here via shell tools using the returned worktree_path)
worktree_status        → check staged/unstaged/untracked
worktree_remove        → clean up when done (requires confirm: true)
```

## Source of truth

`worktree_list` is authoritative. Never assume a worktree exists because you created it earlier
in the session — always verify with `worktree_list` before acting on it.

## Safety contract

`worktree_remove` and `worktree_clean` (with `merged: true` or `closed: true`) are DESTRUCTIVE.
They require `confirm: true` in the call:

```json
{ "branch": "feature-x", "confirm": true }
```

Only pass `confirm: true` when the user has explicitly asked you to delete or clean worktrees.
When in doubt, use `worktree_clean { "dry_run": true }` to preview first.

## Trust model

gtr's `.gtrconfig` postCreate hooks only execute if a human ran `git gtr trust` in that repo.
You cannot trust a repo — this is a human security decision. If `worktree_create` returns
`hooks_ran: false`, a human must run `git gtr trust` before hooks fire.

Never auto-invoke `git gtr trust`. The server does not expose a trust tool for this reason.

## Naming conventions

gtr sanitizes branch names to folder names (`feature/x` → `feature-x`). The `worktree_path`
in the `worktree_create` response is the actual filesystem path to use with your shell tools.

## Resolving a worktree path

Use `worktree_path` to convert a branch name or ID to its absolute filesystem path:

```json
{ "branch": "feature-x" }
```

Returns `{ "path": "/path/to/repo-worktrees/feature-x", "branch": "feature-x" }`. Read-only.

## Seeding a new worktree with gitignored files

Use `worktree_copy` to copy config files, `.env`, or other gitignored files into a fresh worktree:

```json
{ "from": "main", "targets": ["feature-x"], "patterns": [".env", "*.local"], "dry_run": true }
```

- Always run with `dry_run: true` first to preview what would be copied
- Non-destructive: overwrites matching files but never deletes anything in the target
- Omit `patterns` to use the repo's `.gtrconfig` `copy.include` configuration
- Use `all: true` instead of `targets` to propagate to all worktrees at once

## Quick reference

| Tool | Safety | Use when |
|------|--------|----------|
| `worktree_list` | SAFE | Starting any worktree task |
| `worktree_status` | SAFE | Checking changes before cleanup |
| `worktree_path` | SAFE | Resolving a branch to its absolute filesystem path |
| `worktree_create` | MODIFY | Starting new parallel work |
| `worktree_copy` | MODIFY | Seeding a new worktree with gitignored config/env files |
| `worktree_rename` | MODIFY | Renaming a branch + its worktree atomically |
| `worktree_remove` | DESTRUCTIVE | Cleaning up a finished worktree (needs `confirm: true`) |
| `worktree_clean` | SAFE/DESTRUCTIVE | Pruning stale entries (add `confirm: true` for real removal) |
