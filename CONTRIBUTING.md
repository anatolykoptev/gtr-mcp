# Contributing to gtr-mcp

gtr-mcp is a small MCP server, and its value is that an agent cannot do something destructive by
accident. Open an issue before adding a tool, loosening a schema or changing how a subprocess is
started. Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Development

You need Node.js 18 or newer (CI uses 20) and, for the integration tests, `git gtr` on PATH.

```sh
npm install
npm run build        # tsc
npm test             # vitest; the integration suite is skipped without gtr
npm run typecheck    # tsc --noEmit
npm run check        # FF-1: rejects shell execution patterns in src/
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, build, `npm run check`, the FF-3 tool-count ceiling
(at most 8 default `worktree_*` tools), tests and the type check on every pull request. If those pass
locally they pass there. A pull request that changes only documents skips the job.

## Tests

Parsers and schemas have unit tests in `src/__tests__/`. A new tool needs a schema test for its
required fields and, if it can destroy state, a test that the confirm gate refuses without
`confirm: true`. Integration tests must create their own temporary repository and clean it up.

## Commits

Conventional Commits, as in the history: `feat:`, `fix:`, `refactor:`, `test:`, `ci:`, `docs:`,
`chore:`, with `!` for a breaking change (`refactor!:`). Releases are tagged by hand from
`package.json`, so add the entry to [CHANGELOG.md](CHANGELOG.md) in the same change.

## Pull requests

Describe what changed, why, and how it was tested. A new or changed tool is updated in the README
tables and in [AGENTS.md](AGENTS.md) in the same pull request. Update [docs/INDEX.md](docs/INDEX.md)
when you add or rename a document. By contributing you agree your work is licensed under Apache-2.0,
see [LICENSE](LICENSE).
