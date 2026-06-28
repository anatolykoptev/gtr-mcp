#!/usr/bin/env node
/**
 * gtr-mcp — MCP server wrapping git-worktree-runner (gtr)
 *
 * Repo resolution: gtr-mcp operates on the git repository at the working
 * directory it is launched in (process.cwd()). Set your MCP client's `cwd`
 * field to the repository root; one server instance = one repo context.
 *
 * Configuration (env vars or CLI args):
 *   GTR_BIN  – path to the gtr binary (default: uses `git gtr` via PATH)
 *
 * CLI args (take precedence over env vars):
 *   --gtr-bin <path>  – path to the gtr binary
 *
 * Transport: stdio (default for local MCP servers; works with Claude Desktop
 * and any MCP-compatible client).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getTools, makeHandlers, dispatchToolCall } from "./tools/worktree.js";
import { checkGtrAvailable, GtrNotFoundError, getRepoToplevel } from "./gtr.js";

// ---------------------------------------------------------------------------
// Prompt content
// ---------------------------------------------------------------------------

const GTR_WORKFLOW_PROMPT = `# gtr Worktree Workflow Guide

## Repo context

gtr-mcp operates on the git repository at the working directory it was launched
in. You do not pass a repo_path — the server is cwd-bound (one server = one repo).

Use worktrees when:
- Another agent or process holds the main checkout and you need parallel work
- Starting a risky refactor you may want to abandon without touching main
- Running tests on a branch while main stays at a known-good state
- Reviewing a PR branch without disrupting your current workspace

## Standard loop

1. \`worktree_list\` — always start here; it is the source of truth
2. \`worktree_create {branch}\` — creates worktree + optionally a new branch
3. Work in the worktree (use your shell tools with the returned \`worktree_path\`)
4. \`worktree_status {branch}\` — check staged/unstaged/untracked before cleanup
5. \`worktree_remove {branch, confirm: true}\` — only when explicitly asked to delete

## Safety contract

- \`worktree_remove\` and \`worktree_clean\` (with merged/closed flags) require \`confirm: true\`
- This is schema-enforced — you cannot accidentally delete without explicit intent
- Only pass \`confirm: true\` when the user has explicitly asked to delete/clean the worktree
- \`worktree_clean {dry_run: true}\` previews what would be removed — always prefer this first

## Trust model

- gtr's postCreate hooks only run if a human has already run \`git gtr trust\` in that repo
- You cannot trust a repo's hooks — a human must do this out-of-band
- If hooks were skipped, the response will say \`hooks_ran: false\` with a remediation message

## Path resolution

- \`worktree_status\` and \`worktree_remove\` accept the branch name; gtr resolves to the physical path
- The \`worktree_path\` in \`worktree_create\` response is the actual filesystem path
- \`worktree_list\` is authoritative — use it when unsure which worktree exists
- \`worktree_path {branch}\` resolves any branch/identifier to its absolute filesystem path without other side effects

## Seeding a new worktree with ignored files

Use \`worktree_copy\` to copy gitignored config or .env files from one worktree to another:

\`\`\`
worktree_copy {from: "main", targets: ["feature-x"], patterns: [".env", "*.local"], dry_run: true}
\`\`\`

- Always run with \`dry_run: true\` first to preview
- Non-destructive: only overwrites matching files; never deletes anything in the target
- Omit \`patterns\` to use the repo's .gtrconfig \`copy.include\` patterns
- Use \`all: true\` instead of \`targets\` to copy to all existing worktrees`;

// ---------------------------------------------------------------------------
// CLI / env configuration
// ---------------------------------------------------------------------------

interface ServerConfig {
  gtrBin: string | null;
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  let gtrBin = process.env["GTR_BIN"] ?? null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--gtr-bin" && args[i + 1]) {
      gtrBin = args[++i];
    }
  }

  return { gtrBin };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { gtrBin } = parseArgs();

  // Resolve the repo ONCE at startup and operate on its TOPLEVEL — this is the
  // single repo context for every tool call (no per-call repo_path; 1 server =
  // 1 repo). We normalize the launch cwd to the git toplevel so the value we
  // thread into handlers is exactly the value reported in the startup banner,
  // even when launched from a subdirectory of the repo.
  const launchCwd = process.cwd();
  let repoToplevel: string | null = null;
  try {
    repoToplevel = await getRepoToplevel(launchCwd);
  } catch {
    process.stderr.write(
      `gtr-mcp warning: "${launchCwd}" is not a git repository. ` +
      `gtr-mcp operates on the git repository at its working directory; ` +
      `start gtr-mcp with the MCP client's cwd set to a git repository root.\n`
    );
  }

  // When cwd is not a git repo, fall back to the raw launch cwd so each tool
  // call surfaces gtr's own clear "not a git repository" error (non-fatal boot).
  const repoCwd = repoToplevel ?? launchCwd;

  // Fail fast: gtr must be reachable before we accept any connections
  try {
    await checkGtrAvailable(gtrBin ?? undefined);
  } catch (err) {
    if (err instanceof GtrNotFoundError) {
      process.stderr.write(`gtr-mcp startup failed: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Build the handler dispatch table, injecting the resolved cwd
  const handlers = makeHandlers({ repoCwd, gtrBin: gtrBin ?? undefined });
  const tools = getTools();

  const server = new Server(
    {
      name: "gtr-mcp",
      version: "0.4.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // List prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: "gtr-workflow",
          description:
            "Guide for AI agents: when to use worktrees, the create→work→status→remove loop, trust model, and safety contract",
        },
      ],
    };
  });

  // Get prompt
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== "gtr-workflow") {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    return {
      description:
        "Agent guide for git worktree workflow via gtr-mcp",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: GTR_WORKFLOW_PROMPT,
          },
        },
      ],
    };
  });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;

    try {
      // dispatchToolCall coalesces the OPTIONAL MCP `arguments` field (undefined
      // when a client omits it) to {} so no-arg tools parse cleanly; returns
      // null for an unknown tool name.
      const result = await dispatchToolCall(handlers, name, rawArgs);
      if (result === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
      }
      return result;
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Unexpected server error",
              detail: String(err),
            }),
          },
        ],
        isError: true,
      };
    }
  });

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Startup banner — after connect so it lands after transport handshake
  const repoMsg = repoToplevel ? ` repo=${repoToplevel}` : " (no repo context)";
  process.stderr.write(`gtr-mcp v0.4.0 running${repoMsg}\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
