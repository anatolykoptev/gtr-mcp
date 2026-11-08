# Changelog

All notable changes to gtr-mcp. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Releases are tagged by hand; only `v0.4.0` carries a tag.

## [Unreleased]

### Added
- Repository documents: CLAUDE.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, issue and
  pull-request templates, `docs/INDEX.md`, this changelog.

### Fixed
- README: the install section described `npx` and a global npm install, but the package is not on the
  npm registry; it now describes installing from source. The clone URL pointed at the wrong owner.

## [0.4.0] - 2026-06-28

### Changed
- **Breaking:** the server resolves the repository from the working directory it is launched in. The
  `repo_path` argument and the `worktree_exec` tool are removed.

### Fixed
- Omitted MCP arguments are coalesced to an empty object at the dispatch seam, so tools without
  required fields work when a client sends no arguments.
- The integration suite now runs for real instead of passing without executing.

## [0.3.0] - 2026-06-21

### Added
- `worktree_path` (resolve a branch to its filesystem path) and `worktree_copy` (copy files between
  worktrees, with `dry_run`).

## Initial release - 2026-06-21

### Added
- Initial release: an MCP server wrapping git-worktree-runner with list, status, create, rename,
  remove and clean tools, a confirm gate for destructive operations and a workflow prompt.
