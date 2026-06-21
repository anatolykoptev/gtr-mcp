/**
 * gtr subprocess wrapper.
 *
 * Every public function here returns a structured result so that callers
 * never have to parse raw text themselves. The actual parsing lives here,
 * close to the gtr invocations that produce the text.
 *
 * Gate-0 finding (verified against gtr@ad7a3c5):
 *   list.sh calls _tsv_unescape_field when READING records, then outputs via
 *   `printf "%s\t%s\t%s\n" "$path" "$branch" "$status"` — raw real values.
 *   The TSV fields are NOT escape-encoded on output. parsePorcelainList's
 *   split("\t") is therefore correct as-is; no un-escape pass is needed.
 *   A branch/path with a literal tab would corrupt the output — that is a
 *   gtr limitation (documented), not our bug.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface GtrResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorktreeEntry {
  path: string;
  branch: string;
  status: string;
  isMain: boolean;
}

export class GtrError extends Error {
  constructor(
    public readonly exitCode: number,
    public readonly stderr: string,
    public readonly stdout: string,
    message: string
  ) {
    super(message);
    this.name = "GtrError";
  }
}

export class GtrNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GtrNotFoundError";
  }
}

export class GtrTimeoutError extends Error {
  public readonly tool: string;
  public readonly timeoutMs: number;

  constructor(tool: string, timeoutMs: number) {
    super(`gtr ${tool} timed out after ${timeoutMs}ms`);
    this.name = "GtrTimeoutError";
    this.tool = tool;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run `gtr <args>` inside repoPath.
 *
 * gtr is a git subcommand, so we invoke `git gtr ...` with the repo as cwd.
 * If gtrBin is set, that binary is called directly (useful in tests or when
 * gtr is not installed system-wide).
 *
 * NEVER uses shell: true — all args are passed as an array to execFile to
 * prevent command injection.
 */
export async function runGtr(
  args: string[],
  repoPath: string,
  gtrBin?: string,
  timeoutMs?: number
): Promise<GtrResult> {
  const [cmd, ...cmdArgs] = gtrBin
    ? [gtrBin, ...args]
    : ["git", "gtr", ...args];

  const tool = args[0] ?? "";

  try {
    const options: Parameters<typeof execFileAsync>[2] = {
      cwd: repoPath,
      encoding: "utf8" as const,
      // Allow gtr to produce coloured output — we strip ANSI ourselves.
      // GIT_TERMINAL_PROMPT=0 prevents git from hanging waiting for a password.
      env: {
        ...process.env,
        NO_COLOR: "1",
        GTR_COLOR: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxBuffer: 10 * 1024 * 1024,
    };

    if (timeoutMs !== undefined) {
      options.signal = AbortSignal.timeout(timeoutMs);
    }

    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, options) as { stdout: string; stderr: string };
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    // AbortError is thrown by AbortSignal.timeout when the deadline passes
    if (err instanceof Error && err.name === "AbortError") {
      throw new GtrTimeoutError(tool, timeoutMs ?? 0);
    }
    // execFile rejects with an object that carries code, stdout, stderr
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    const exitCode = typeof e.code === "number" ? e.code : 1;
    const stderr = e.stderr ?? "";
    const stdout = e.stdout ?? "";
    throw new GtrError(
      exitCode,
      stderr,
      stdout,
      `gtr ${tool} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`
    );
  }
}

// Timeout for bare git commands (rev-parse, status). Must match or be tighter
// than the tool-level timeouts in worktree.ts so a hung git can't block the
// single-threaded server indefinitely.
const GIT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Run `git <args>` without involving gtr, using the given cwd.
 * Used for low-level git operations (rev-parse, status).
 * NEVER uses shell: true.
 */
async function runGitCommand(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 10 * 1024 * 1024,
    signal: AbortSignal.timeout(GIT_COMMAND_TIMEOUT_MS),
  });
  return { stdout, stderr };
}

/**
 * Validate that repoPath is a real git repository.
 * Throws GtrError with an actionable message if not.
 */
export async function validateRepoPath(repoPath: string): Promise<void> {
  try {
    await runGitCommand(["rev-parse", "--git-dir"], repoPath);
  } catch {
    throw new GtrError(
      128,
      "",
      "",
      `Not a git repository: ${repoPath}. ` +
        `Ensure the path is an absolute path to a git repository root and try again.`
    );
  }
}

/**
 * Resolve a worktree's physical filesystem path for a given branch using `gtr go`.
 * `gtr go` prints the resolved path to stdout and human messages to stderr.
 */
export async function resolveWorktreePath(
  branch: string,
  repoPath: string,
  gtrBin?: string
): Promise<string> {
  try {
    const result = await runGtr(["go", branch], repoPath, gtrBin);
    return result.stdout.trim();
  } catch (err) {
    if (err instanceof GtrError) {
      throw new GtrNotFoundError(
        `Worktree for branch "${branch}" not found in ${repoPath}. ` +
          `Run "git gtr list" to see available worktrees. ` +
          `Original error: ${err.message}`
      );
    }
    throw err;
  }
}

/**
 * Check that gtr is available by running --version.
 * Throws GtrNotFoundError with remediation instructions if not found.
 */
export async function checkGtrAvailable(gtrBin?: string): Promise<void> {
  const [cmd, ...args] = gtrBin
    ? [gtrBin, "--version"]
    : ["git", "gtr", "--version"];

  try {
    await execFileAsync(cmd, args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 64 * 1024,
    });
  } catch {
    const binDesc = gtrBin ? `"${gtrBin}"` : '"git gtr"';
    throw new GtrNotFoundError(
      `gtr not found (tried ${binDesc}). ` +
        `Install git-worktree-runner: https://github.com/coderabbitai/git-worktree-runner ` +
        `or set GTR_BIN env var / --gtr-bin CLI arg to the binary path.`
    );
  }
}

/**
 * Run `git status --short` directly (gtr has no status subcommand).
 */
export async function runGitStatus(worktreePath: string): Promise<GtrResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["status", "--short", "--branch"],
      {
        cwd: worktreePath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        signal: AbortSignal.timeout(GIT_COMMAND_TIMEOUT_MS),
      }
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GtrTimeoutError("status", GIT_COMMAND_TIMEOUT_MS);
    }
    const e = err as { code?: number; stdout?: string; stderr?: string };
    throw new GtrError(
      typeof e.code === "number" ? e.code : 1,
      e.stderr ?? "",
      e.stdout ?? "",
      `git status failed in ${worktreePath}`
    );
  }
}

/**
 * Parse the `--porcelain` output of `git gtr list`.
 *
 * Porcelain format (from list.sh after internal unescape):
 *   path<TAB>branch<TAB>status
 * with the main repo listed first.
 *
 * Fields ARE raw real values — no escape encoding in the output.
 * A literal tab in a branch/path would corrupt the TSV (gtr limitation).
 * We handle parts.length > 3 gracefully by joining surplus parts back.
 */
export function parsePorcelainList(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  // The main repo comes first in gtr's porcelain output
  let firstLine = true;
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;

    // Join any extra tab-split parts back into the last field so a tab in a
    // branch/path doesn't silently truncate data (documents the gtr limitation).
    const path = parts[0];
    const branch = parts.length === 2 ? parts[1] : parts.slice(1, -1).join("\t");
    const status = parts.length >= 3 ? parts[parts.length - 1] : "";

    entries.push({
      path: path.trim(),
      branch: branch.trim(),
      status: status.trim(),
      isMain: firstLine,
    });
    firstLine = false;
  }

  return entries;
}

/**
 * Parse `git status --short --branch` output into a structured object.
 *
 * Header line formats handled:
 *   ## main...origin/main [ahead 1, behind 2]  → branch + upstream
 *   ## main                                      → branch, no upstream
 *   ## HEAD (no branch)                          → detached HEAD
 *   ## No commits yet on main                   → branch, no upstream, no commits
 */
export interface GitStatusResult {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

export function parseGitStatus(raw: string): GitStatusResult {
  const lines = raw.split("\n");
  let branch = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const header = line.slice(3);

      // Detached HEAD: "HEAD (no branch)"
      if (header.startsWith("HEAD (no branch)")) {
        branch = "(detached HEAD)";
        upstream = null;
        continue;
      }

      // With upstream tracking: "main...origin/main [ahead 1, behind 2]"
      const trackingMatch = header.match(/^(.+?)\.\.\.(.+?)(\s+\[(.+?)\])?$/);
      if (trackingMatch) {
        branch = trackingMatch[1];
        upstream = trackingMatch[2];
        const trackingInfo = trackingMatch[4] ?? "";
        const aheadMatch = trackingInfo.match(/ahead (\d+)/);
        const behindMatch = trackingInfo.match(/behind (\d+)/);
        if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
        if (behindMatch) behind = parseInt(behindMatch[1], 10);
        continue;
      }

      // No commits yet: "No commits yet on main"
      if (header.startsWith("No commits yet on ")) {
        branch = header.slice("No commits yet on ".length);
        upstream = null;
        continue;
      }

      // Plain branch with no upstream: "main"
      branch = header;
      upstream = null;
      continue;
    }

    if (line.length < 2) continue;
    const xy = line.slice(0, 2);
    const file = line.slice(3);
    if (xy === "??") {
      untracked.push(file);
    } else {
      if (xy[0] !== " " && xy[0] !== "?") staged.push(file);
      if (xy[1] !== " " && xy[1] !== "?") unstaged.push(file);
    }
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
  };
}
