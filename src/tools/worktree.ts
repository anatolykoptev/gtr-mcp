/**
 * MCP tool definitions for gtr worktree operations.
 *
 * Safety classification used throughout:
 *   SAFE        – read-only, no git state changes
 *   MODIFY      – creates or moves state (new branch, new directory)
 *   DESTRUCTIVE – removes state (worktree directory, branch)
 *
 * Every DESTRUCTIVE tool requires { confirm: true } in its input to prevent
 * accidental execution by an agent that inferred the wrong intent.
 *
 * exec tool: excluded from BASE_TOOLS; opt-in via GTR_MCP_ENABLE_EXEC=1.
 * Use getTools(enableExec) to get the appropriate tool list.
 *
 * --yes flag wiring:
 *   mv (rename): always pass --yes
 *   rm (remove): pass --yes ONLY when delete_branch===true
 *   clean:       pass --yes ONLY when NOT dry_run
 */

import path from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  runGtr,
  runGitStatus,
  parsePorcelainList,
  parseGitStatus,
  resolveWorktreePath,
  validateRepoPath,
  GtrError,
  GtrNotFoundError,
  GtrTimeoutError,
  WorktreeEntry,
  GitStatusResult,
} from "../gtr.js";

// ---------------------------------------------------------------------------
// Per-tool timeouts (ms)
// ---------------------------------------------------------------------------

const TIMEOUT_MODIFY = 120_000; // create, rename, remove
const TIMEOUT_READ = 90_000; // list, status, clean

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: message, ...extra }, null, 2),
      },
    ],
  };
}

function handleGtrError(err: unknown): ToolResult {
  if (err instanceof GtrTimeoutError) {
    return fail(`Operation timed out after ${err.timeoutMs}ms`, {
      tool: err.tool,
      timeoutMs: err.timeoutMs,
    });
  }
  if (err instanceof GtrNotFoundError) {
    return fail(err.message);
  }
  if (err instanceof GtrError) {
    return fail(err.message, {
      exitCode: err.exitCode,
      stderr: err.stderr,
      stdout: err.stdout,
    });
  }
  return fail(String(err));
}

/**
 * Detect if gtr skipped hooks due to missing trust.
 * Returns true if the output contains no "untrusted" / "hooks skipped" signals.
 *
 * Pinned to gtr@ad7a3c5 exact strings:
 *   lib/hooks.sh:202  → "Untrusted .gtrconfig hooks for '...' phase — skipping"
 *   lib/config.sh:462 → "Untrusted .gtrconfig ... skipped — run: git gtr trust"
 *
 * Key discriminator token: "untrusted .gtrconfig" (appears in both paths,
 * lowercased for case-insensitive match against terminal output).
 */
export function detectHooksRan(stdout: string): boolean {
  const lower = stdout.toLowerCase();
  return !(
    // gtr@ad7a3c5 lib/hooks.sh:202, lib/config.sh:462
    lower.includes("untrusted .gtrconfig")
  );
}

// ---------------------------------------------------------------------------
// Tool schemas (used for both MCP Tool definitions and runtime validation)
// ---------------------------------------------------------------------------

// worktree_list – SAFE
export const worktreeListSchema = z.object({
  repo_path: z.string().describe("Absolute path to the git repository root"),
});

// worktree_create – MODIFY
export const worktreeCreateSchema = z.object({
  repo_path: z.string().describe("Absolute path to the git repository root"),
  branch: z
    .string()
    .refine((v) => !v.startsWith("-"), {
      message: "branch must not start with '-' (option-injection guard)",
    })
    .describe("Branch name to create (or check out if it already exists)"),
  from_ref: z
    .string()
    .refine((v) => !v.startsWith("-"), {
      message: "from_ref must not start with '-' (option-injection guard)",
    })
    .optional()
    .describe(
      "Base ref to branch from (e.g. 'main', 'origin/main'). Defaults to the repo default branch."
    ),
  from_current: z
    .coerce
    .boolean()
    .optional()
    .describe("Branch from the currently checked-out branch instead of the default"),
  no_copy: z
    .coerce
    .boolean()
    .optional()
    .describe("Skip file-copy step configured in .gtrconfig"),
  no_hooks: z
    .coerce
    .boolean()
    .optional()
    .describe("Skip postCreate hooks"),
  no_fetch: z
    .coerce
    .boolean()
    .optional()
    .describe("Skip fetching from remote before creating"),
  name: z
    .string()
    .refine((v) => !v.startsWith("-"), {
      message: "name must not start with '-' (option-injection guard)",
    })
    .optional()
    .describe("Worktree directory name override (alias for folder)"),
  folder: z
    .string()
    .refine((v) => !v.startsWith("-"), {
      message: "folder must not start with '-' (option-injection guard)",
    })
    .refine((v) => !v.includes("/") && !v.includes("\\") && v !== ".." && !v.startsWith(".."), {
      message: "folder must be a single path segment (no separators or '..')",
    })
    .optional()
    .describe("Override the worktree directory name (single path segment; no separators or '..')"),
});

// worktree_remove – DESTRUCTIVE
export const worktreeRemoveSchema = z.object({
  repo_path: z.string().describe("Absolute path to the git repository root"),
  branch: z
    .string()
    .refine((v) => !v.startsWith("-"), {
      message: "branch must not start with '-' (option-injection guard)",
    })
    .describe("Branch name (or worktree ID) to remove"),
  delete_branch: z
    .coerce
    .boolean()
    .optional()
    .describe("Also delete the git branch after removing the worktree"),
  force: z
    .coerce
    .boolean()
    .optional()
    .describe("Skip pre-remove hooks and force removal even with uncommitted changes"),
  confirm: z
    .literal(true)
    .describe("Must be set to true to confirm this destructive operation"),
});

// worktree_exec – MODIFY (can have side effects inside the worktree)
export const worktreeExecSchema = z.object({
  repo_path: z.string().describe("Absolute path to the git repository root"),
  branch: z
    .string()
    .refine((v) => !v.startsWith("-"), {
      message: "branch must not start with '-' (option-injection guard)",
    })
    .describe("Branch name (or worktree ID) to run the command in"),
  command: z
    .array(z.string())
    .min(1)
    .describe("Command and arguments to run inside the worktree directory"),
});

// worktree_status – SAFE
export const worktreeStatusSchema = z.object({
  repo_path: z.string().describe("Absolute path to the git repository root"),
  branch: z
    .string()
    .refine((v) => !v.startsWith("-"), {
      message: "branch must not start with '-' (option-injection guard)",
    })
    .describe("Branch name (or worktree ID) to inspect"),
});

// worktree_rename – MODIFY
export const worktreeRenameSchema = z.object({
  repo_path: z.string().describe("Absolute path to the git repository root"),
  old_branch: z
    .string()
    .refine((v) => !v.startsWith("-"), {
      message: "old_branch must not start with '-' (option-injection guard)",
    })
    .describe("Current branch name / worktree identifier"),
  new_branch: z
    .string()
    .refine((v) => !v.startsWith("-"), {
      message: "new_branch must not start with '-' (option-injection guard)",
    })
    .describe("New branch name"),
});

// worktree_clean – MODIFY (prunes stale entries; with --merged/--closed becomes DESTRUCTIVE)
// confirm is required when (merged || closed) && !dry_run
export const worktreeCleanSchema = z
  .object({
    repo_path: z.string().describe("Absolute path to the git repository root"),
    merged: z
      .coerce
      .boolean()
      .optional()
      .describe("Also remove worktrees whose PRs are merged"),
    closed: z
      .coerce
      .boolean()
      .optional()
      .describe("Also remove worktrees whose PRs are closed"),
    dry_run: z
      .coerce
      .boolean()
      .optional()
      .describe("Preview what would be removed without making changes"),
    confirm: z
      .literal(true)
      .optional()
      .describe("Required when merged or closed flags are set and dry_run is not"),
  })
  .refine(
    (data) => {
      const isDestructive = (data.merged || data.closed) && !data.dry_run;
      if (isDestructive && data.confirm !== true) return false;
      return true;
    },
    {
      message:
        "confirm: true is required when merged or closed is set and dry_run is not true",
    }
  );

// ---------------------------------------------------------------------------
// Tool definitions (MCP schema surface)
// ---------------------------------------------------------------------------

const BASE_TOOLS: Tool[] = [
  {
    name: "worktree_list",
    description:
      "List all git worktrees in the repository. Returns structured data with path, branch, status, and whether each entry is the main checkout. SAFE – read-only.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: {
          type: "string",
          description: "Absolute path to the git repository root",
        },
      },
      required: ["repo_path"],
    },
  },
  {
    name: "worktree_create",
    description:
      "Create a new git worktree for the given branch. If the branch does not exist it is created from the default remote branch (or from_ref). Copies configured files and runs postCreate hooks unless disabled. MODIFY – creates a directory and optionally a new branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: {
          type: "string",
          description: "Absolute path to the git repository root",
        },
        branch: {
          type: "string",
          description: "Branch name to create or check out",
        },
        from_ref: {
          type: "string",
          description: "Base ref to branch from (e.g. 'main', 'origin/main')",
        },
        from_current: {
          type: "boolean",
          description: "Branch from the currently checked-out branch",
        },
        no_copy: {
          type: "boolean",
          description: "Skip the configured file-copy step",
        },
        no_hooks: {
          type: "boolean",
          description: "Skip postCreate hooks",
        },
        no_fetch: {
          type: "boolean",
          description: "Skip fetching from remote before creating",
        },
        name: {
          type: "string",
          description: "Worktree directory name override (alias for folder)",
        },
        folder: {
          type: "string",
          description: "Override the worktree directory name",
        },
      },
      required: ["repo_path", "branch"],
    },
  },
  {
    name: "worktree_remove",
    description:
      "Remove a worktree and optionally delete its branch. DESTRUCTIVE – removes the worktree directory from disk and from git's registry. Requires confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: {
          type: "string",
          description: "Absolute path to the git repository root",
        },
        branch: {
          type: "string",
          description: "Branch name or worktree ID to remove",
        },
        delete_branch: {
          type: "boolean",
          description: "Also delete the git branch after removing the worktree",
        },
        force: {
          type: "boolean",
          description: "Force removal even if hooks fail or worktree has changes",
        },
        confirm: {
          type: "boolean",
          enum: [true],
          description: "Must be true to confirm this destructive operation",
        },
      },
      required: ["repo_path", "branch", "confirm"],
    },
  },
  {
    name: "worktree_status",
    description:
      "Get git status (branch, staged/unstaged/untracked files, ahead/behind upstream) for a worktree. Uses git directly since gtr has no status subcommand. SAFE – read-only.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: {
          type: "string",
          description: "Absolute path to the git repository root",
        },
        branch: {
          type: "string",
          description: "Branch name or worktree ID to inspect",
        },
      },
      required: ["repo_path", "branch"],
    },
  },
  {
    name: "worktree_rename",
    description:
      "Rename a worktree and its branch atomically (branch rename + directory move with rollback on failure). MODIFY – moves directory and renames the branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: {
          type: "string",
          description: "Absolute path to the git repository root",
        },
        old_branch: {
          type: "string",
          description: "Current branch name or worktree identifier",
        },
        new_branch: {
          type: "string",
          description: "New branch name",
        },
      },
      required: ["repo_path", "old_branch", "new_branch"],
    },
  },
  {
    name: "worktree_clean",
    description:
      "Prune stale worktree administrative files and remove empty worktree directories. With merged/closed flags it also removes worktrees whose PRs are merged or closed (requires GitHub or GitLab CLI). Requires confirm: true when merged or closed is set and dry_run is not. MODIFY/DESTRUCTIVE depending on flags – use dry_run: true to preview.",
    inputSchema: {
      type: "object",
      properties: {
        repo_path: {
          type: "string",
          description: "Absolute path to the git repository root",
        },
        merged: {
          type: "boolean",
          description: "Remove worktrees with merged PRs",
        },
        closed: {
          type: "boolean",
          description: "Remove worktrees with closed PRs",
        },
        dry_run: {
          type: "boolean",
          description: "Preview only, make no changes",
        },
        confirm: {
          type: "boolean",
          enum: [true],
          description: "Required when merged or closed is set and dry_run is not",
        },
      },
      required: ["repo_path"],
    },
  },
];

export const EXEC_TOOL: Tool = {
  name: "worktree_exec",
  description:
    "Run an arbitrary command inside a worktree directory. The command runs with the worktree as its cwd. Exit code and output are returned. MODIFY – side effects depend on the command. DISABLED by default; set GTR_MCP_ENABLE_EXEC=1 to enable. Prefer your shell tool over this.",
  inputSchema: {
    type: "object",
    properties: {
      repo_path: {
        type: "string",
        description: "Absolute path to the git repository root",
      },
      branch: {
        type: "string",
        description: "Branch name or worktree ID to run the command in",
      },
      command: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Command and arguments to execute",
      },
    },
    required: ["repo_path", "branch", "command"],
  },
};

/**
 * Return the tool list for this server instance.
 * exec is excluded unless explicitly opted in.
 */
export function getTools(enableExec: boolean): Tool[] {
  return [...BASE_TOOLS, ...(enableExec ? [EXEC_TOOL] : [])];
}

// Keep TOOLS export for backwards compat (default: exec excluded)
export const TOOLS: Tool[] = BASE_TOOLS;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleWorktreeList(
  input: unknown
): Promise<ToolResult> {
  const parsed = worktreeListSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", { issues: parsed.error.issues });

  const { repo_path } = parsed.data;
  try {
    await validateRepoPath(repo_path);
    const result = await runGtr(["list", "--porcelain"], repo_path, undefined, TIMEOUT_READ);
    const entries: WorktreeEntry[] = parsePorcelainList(result.stdout);
    return ok({ worktrees: entries, count: entries.length });
  } catch (err) {
    return handleGtrError(err);
  }
}

export async function handleWorktreeCreate(
  input: unknown
): Promise<ToolResult> {
  const parsed = worktreeCreateSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", { issues: parsed.error.issues });

  const { repo_path, branch, from_ref, from_current, no_copy, no_hooks, no_fetch, name, folder } =
    parsed.data;

  try {
    await validateRepoPath(repo_path);

    const args: string[] = ["new", branch, "--yes"];
    if (from_ref) args.push("--from", from_ref);
    if (from_current) args.push("--from-current");
    if (no_copy) args.push("--no-copy");
    if (no_hooks) args.push("--no-hooks");
    if (no_fetch) args.push("--no-fetch");
    if (folder) args.push("--folder", folder);
    else if (name) args.push("--folder", name);

    const result = await runGtr(args, repo_path, undefined, TIMEOUT_MODIFY);

    // Extract the created path from gtr output ("Worktree created: <path>")
    const pathMatch = result.stdout.match(/Worktree created:\s*(.+)/);
    const worktreePath = pathMatch ? pathMatch[1].trim() : null;

    const hooksRan = detectHooksRan(result.stdout);
    const response: Record<string, unknown> = {
      success: true,
      branch,
      worktree_path: worktreePath,
      hooks_ran: hooksRan,
      output: result.stdout.trim(),
    };

    if (!hooksRan) {
      response.hooks_remediation =
        'Hooks were skipped because this repo is not trusted. ' +
        'A human must run "git gtr trust" in the repo root to enable hooks.';
    }

    return ok(response);
  } catch (err) {
    return handleGtrError(err);
  }
}

export async function handleWorktreeRemove(
  input: unknown
): Promise<ToolResult> {
  const parsed = worktreeRemoveSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", { issues: parsed.error.issues });

  // confirm: true is enforced by the Zod schema (z.literal(true)), so if we
  // reach here the caller has explicitly confirmed.
  const { repo_path, branch, delete_branch, force } = parsed.data;

  try {
    await validateRepoPath(repo_path);

    // --yes is passed ONLY when delete_branch is true (removes the branch ref).
    // Without delete_branch, --yes is not needed and would be incorrect.
    const args: string[] = ["rm", branch];
    if (delete_branch) args.push("--yes"); // --yes confirms branch deletion
    if (force) args.push("--force");

    const result = await runGtr(args, repo_path, undefined, TIMEOUT_MODIFY);
    return ok({
      success: true,
      branch,
      branch_deleted: delete_branch === true,
      output: result.stdout.trim(),
    });
  } catch (err) {
    return handleGtrError(err);
  }
}

export async function handleWorktreeExec(
  input: unknown
): Promise<ToolResult> {
  const parsed = worktreeExecSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", { issues: parsed.error.issues });

  const { repo_path, branch, command } = parsed.data;

  try {
    await validateRepoPath(repo_path);

    // gtr run <branch> <cmd> [args...]
    const args = ["run", branch, "--", ...command];
    const result = await runGtr(args, repo_path, undefined, TIMEOUT_MODIFY);
    return ok({
      success: true,
      branch,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (err) {
    if (err instanceof GtrError) {
      // Propagate the command's exit code and output rather than treating it
      // as a gtr-level error. The caller can inspect exitCode to decide.
      return ok({
        success: false,
        branch,
        command,
        exitCode: err.exitCode,
        stdout: err.stdout,
        stderr: err.stderr,
      });
    }
    return handleGtrError(err);
  }
}

export async function handleWorktreeStatus(
  input: unknown
): Promise<ToolResult> {
  const parsed = worktreeStatusSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", { issues: parsed.error.issues });

  const { repo_path, branch } = parsed.data;
  try {
    await validateRepoPath(repo_path);
    // Resolve the physical path first via gtr go
    const worktreePath = await resolveWorktreePath(branch, repo_path);
    const result = await runGitStatus(worktreePath);
    const status: GitStatusResult = parseGitStatus(result.stdout);
    return ok({ worktree_path: worktreePath, status });
  } catch (err) {
    return handleGtrError(err);
  }
}

export async function handleWorktreeRename(
  input: unknown
): Promise<ToolResult> {
  const parsed = worktreeRenameSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", { issues: parsed.error.issues });

  const { repo_path, old_branch, new_branch } = parsed.data;

  try {
    await validateRepoPath(repo_path);

    // --yes always passed for rename (mv confirms the rename atomically)
    const args = ["mv", old_branch, new_branch, "--yes"];
    const result = await runGtr(args, repo_path, undefined, TIMEOUT_MODIFY);
    return ok({
      success: true,
      old_branch,
      new_branch,
      output: result.stdout.trim(),
    });
  } catch (err) {
    return handleGtrError(err);
  }
}

export async function handleWorktreeClean(
  input: unknown
): Promise<ToolResult> {
  const parsed = worktreeCleanSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", { issues: parsed.error.issues });

  const { repo_path, merged, closed, dry_run } = parsed.data;

  try {
    await validateRepoPath(repo_path);

    const args: string[] = ["clean"];
    if (merged) args.push("--merged");
    if (closed) args.push("--closed");
    if (dry_run) {
      args.push("--dry-run");
    } else {
      // --yes is always passed for non-dry-run.
      // On the plain prune path (no --merged/--closed), gtr clean @ad7a3c5 only uses
      // yes_mode in _clean_locked_phantoms to auto-confirm unlocking entries whose
      // directories are already gone — no real worktree or branch is removed.
      // On the --merged/--closed path, yes_mode drives _clean_prs, but that path
      // requires confirm: true in the schema (enforced above by worktreeCleanSchema).
      args.push("--yes");
    }

    const result = await runGtr(args, repo_path, undefined, TIMEOUT_READ);
    return ok({ success: true, output: result.stdout.trim() });
  } catch (err) {
    return handleGtrError(err);
  }
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

type Handler = (input: unknown) => Promise<ToolResult>;

export const HANDLERS: Record<string, Handler> = {
  worktree_list: handleWorktreeList,
  worktree_create: handleWorktreeCreate,
  worktree_remove: handleWorktreeRemove,
  worktree_exec: handleWorktreeExec,
  worktree_status: handleWorktreeStatus,
  worktree_rename: handleWorktreeRename,
  worktree_clean: handleWorktreeClean,
};
