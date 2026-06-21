#!/usr/bin/env node
/**
 * gtr-mcp — MCP server wrapping git-worktree-runner (gtr)
 *
 * Configuration (env vars or CLI args):
 *   GTR_MCP_REPO_PATH    – default repository path used when callers omit repo_path
 *   GTR_MCP_REPO_BASE    – if set, repo_path must be under this directory
 *   GTR_BIN              – path to the gtr binary (default: uses `git gtr` via PATH)
 *   GTR_MCP_ENABLE_EXEC  – set to "1" to expose the worktree_exec tool
 *
 * CLI args (take precedence over env vars):
 *   --repo-path <path>   – default repository path
 *   --repo-base <path>   – base directory restriction
 *   --gtr-bin <path>     – path to the gtr binary
 *
 * Transport: stdio (default for local MCP servers; works with Claude Desktop
 * and any MCP-compatible client).
 */

import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getTools, HANDLERS } from "./tools/worktree.js";
import { checkGtrAvailable, GtrNotFoundError, validateRepoPath } from "./gtr.js";
import { validateRepoBase } from "./paths.js";

// ---------------------------------------------------------------------------
// Prompt content
// ---------------------------------------------------------------------------

const GTR_WORKFLOW_PROMPT = `# gtr Worktree Workflow Guide

Use git worktrees (via gtr) when:
- Another agent or process holds the main checkout and you need parallel work
- Starting a risky refactor you may want to abandon without touching main
- Running tests on a branch while main stays at a known-good state
- Reviewing a PR branch without disrupting your current workspace

## Standard loop

1. \`worktree_list\` — always start here; it is the source of truth
2. \`worktree_create {repo_path, branch}\` — creates worktree + optionally a new branch
3. Work in the worktree (use your shell tools with the returned \`worktree_path\`)
4. \`worktree_status {repo_path, branch}\` — check staged/unstaged/untracked before cleanup
5. \`worktree_remove {repo_path, branch, confirm: true}\` — only when explicitly asked to delete

## Safety contract

- \`worktree_remove\` and \`worktree_clean\` (with merged/closed flags) require \`confirm: true\`
- This is schema-enforced — you cannot accidentally delete without explicit intent
- Only pass \`confirm: true\` when the user has explicitly asked to delete/clean the worktree
- \`worktree_clean {dry_run: true}\` previews what would be removed — always prefer this first

## Trust model

- gtr's postCreate hooks only run if a human has already run \`git gtr trust\` in that repo
- You cannot trust a repo's hooks — a human must do this out-of-band
- If hooks were skipped, the response will say \`hooks_ran: false\` with a remediation message

## exec tool

- \`worktree_exec\` is disabled by default (set \`GTR_MCP_ENABLE_EXEC=1\` to enable)
- Even when enabled, use your shell tool instead — exec is redundant and widens the trust surface

## Path resolution

- \`worktree_status\` and \`worktree_remove\` accept the branch name; gtr resolves to the physical path
- The \`worktree_path\` in \`worktree_create\` response is the actual filesystem path
- \`worktree_list\` is authoritative — use it when unsure which worktree exists`;

// ---------------------------------------------------------------------------
// CLI / env configuration
// ---------------------------------------------------------------------------

interface ServerConfig {
  repoPath: string | null;
  repoBase: string | null;
  gtrBin: string | null;
  enableExec: boolean;
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  let repoPath = process.env["GTR_MCP_REPO_PATH"] ?? process.env["GTR_REPO_PATH"] ?? null;
  let repoBase = process.env["GTR_MCP_REPO_BASE"] ?? null;
  let gtrBin = process.env["GTR_BIN"] ?? null;
  const enableExec = process.env["GTR_MCP_ENABLE_EXEC"] === "1";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-path" && args[i + 1]) {
      repoPath = args[++i];
    } else if (args[i] === "--repo-base" && args[i + 1]) {
      repoBase = args[++i];
    } else if (args[i] === "--gtr-bin" && args[i + 1]) {
      gtrBin = args[++i];
    }
  }

  return { repoPath, repoBase, gtrBin, enableExec };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = parseArgs();
  const { repoPath, repoBase, gtrBin, enableExec } = config;

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

  const tools = getTools(enableExec);

  const server = new Server(
    {
      name: "gtr-mcp",
      version: "0.2.0",
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

    // Inject server-level repo_path default if caller did not provide one
    let args =
      repoPath && rawArgs && typeof rawArgs === "object" && !("repo_path" in rawArgs)
        ? { repo_path: repoPath, ...rawArgs }
        : rawArgs;

    // Validate repo_path against repo_base restriction (if configured)
    if (
      args &&
      typeof args === "object" &&
      "repo_path" in args &&
      typeof (args as Record<string, unknown>)["repo_path"] === "string"
    ) {
      const callRepoPath = (args as Record<string, unknown>)["repo_path"] as string;
      if (repoBase) {
        try {
          validateRepoBase(callRepoPath, repoBase);
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: String(err),
                }),
              },
            ],
            isError: true,
          };
        }
      }
      // Per-call repo_path validation via git rev-parse
      try {
        await validateRepoPath(callRepoPath);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: String(err),
              }),
            },
          ],
          isError: true,
        };
      }
    }

    const handler = HANDLERS[name];
    if (!handler) {
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

    try {
      return await handler(args);
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

  // Log to stderr (stdout is the MCP wire)
  const repoMsg = repoPath ? ` (default repo: ${repoPath})` : "";
  const execMsg = enableExec ? " [exec enabled]" : "";
  process.stderr.write(`gtr-mcp v0.2.0 running${repoMsg}${execMsg}\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
