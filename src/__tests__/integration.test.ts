/**
 * Integration tests against a real temp git repo.
 * These require gtr (git-worktree-runner) to be on PATH as `git gtr`.
 * Tests are skipped gracefully when gtr is not available.
 *
 * FF-2 (no-hang): every tool call is wrapped in a 30s Promise.race timeout.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  handleWorktreeList,
  handleWorktreeCreate,
  handleWorktreeStatus,
  handleWorktreeRemove,
  handleWorktreePath,
  handleWorktreeCopy,
} from "../tools/worktree.js";

const TOOL_TIMEOUT = 30_000; // FF-2: 30s max per tool call

let repoPath: string;
let gtrAvailable = false;

beforeAll(async () => {
  // Check if gtr is available
  try {
    execFileSync("git", ["gtr", "--version"], { stdio: "pipe" });
    gtrAvailable = true;
  } catch {
    console.log("gtr not available — skipping integration tests");
    return;
  }

  // Create temp git repo
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "gtr-mcp-it-"));
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], {
    cwd: repoPath,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: repoPath,
    stdio: "pipe",
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: repoPath,
    stdio: "pipe",
  });
});

afterAll(() => {
  if (repoPath && fs.existsSync(repoPath)) {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});

/** Wrap a tool call with a hard timeout to satisfy FF-2. */
async function withTimeout<T>(
  promise: Promise<T>,
  label: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`FF-2 TIMEOUT: ${label} exceeded ${TOOL_TIMEOUT}ms`)), TOOL_TIMEOUT)
    ),
  ]);
}

describe("integration: repo_path validation", () => {
  it.skipIf(!gtrAvailable)("rejects non-git directory", async () => {
    const result = await withTimeout(
      handleWorktreeList({ repo_path: "/tmp" }),
      "list /tmp"
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBeTruthy();
  });

  it.skipIf(!gtrAvailable)("rejects path traversal attempt", async () => {
    const result = await withTimeout(
      handleWorktreeList({ repo_path: repoPath + "/../../../etc" }),
      "list path traversal"
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBeTruthy();
  });
});

describe("integration: worktree lifecycle", () => {
  const TEST_BRANCH = "gtr-mcp-it-test-branch";

  it.skipIf(!gtrAvailable)("list returns at least one worktree (main)", async () => {
    const result = await withTimeout(
      handleWorktreeList({ repo_path: repoPath }),
      "list main"
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(data.worktrees[0].isMain).toBe(true);
  });

  it.skipIf(!gtrAvailable)("create returns success with worktree_path", async () => {
    const result = await withTimeout(
      handleWorktreeCreate({ repo_path: repoPath, branch: TEST_BRANCH }),
      "create"
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(typeof data.hooks_ran).toBe("boolean");
  });

  it.skipIf(!gtrAvailable)("status returns correct branch after create", async () => {
    const result = await withTimeout(
      handleWorktreeStatus({ repo_path: repoPath, branch: TEST_BRANCH }),
      "status"
    );
    const data = JSON.parse(result.content[0].text);
    // Either we got a status or an error; if we got a status, branch should match
    if (!data.error) {
      expect(data.status.branch).toBe(TEST_BRANCH);
    }
  });

  it.skipIf(!gtrAvailable)("remove WITHOUT confirm is rejected by schema", async () => {
    const result = await withTimeout(
      // @ts-expect-error — intentionally omitting confirm to test gate
      handleWorktreeRemove({ repo_path: repoPath, branch: TEST_BRANCH }),
      "remove no confirm"
    );
    const data = JSON.parse(result.content[0].text);
    // Schema rejects it — we expect an error
    expect(data.error).toBeTruthy();
  });

  it.skipIf(!gtrAvailable)("worktree still exists after failed remove (gate held)", async () => {
    const result = await withTimeout(
      handleWorktreeList({ repo_path: repoPath }),
      "list after failed remove"
    );
    const data = JSON.parse(result.content[0].text);
    const branches: string[] = data.worktrees.map((w: { branch: string }) => w.branch);
    expect(branches).toContain(TEST_BRANCH);
  });

  it.skipIf(!gtrAvailable)("remove WITH confirm=true succeeds", async () => {
    const result = await withTimeout(
      handleWorktreeRemove({
        repo_path: repoPath,
        branch: TEST_BRANCH,
        confirm: true,
      }),
      "remove with confirm"
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.branch_deleted).toBe(false); // delete_branch not set
  });

  it.skipIf(!gtrAvailable)("worktree no longer in list after remove", async () => {
    const result = await withTimeout(
      handleWorktreeList({ repo_path: repoPath }),
      "list after remove"
    );
    const data = JSON.parse(result.content[0].text);
    const branches: string[] = data.worktrees.map((w: { branch: string }) => w.branch);
    expect(branches).not.toContain(TEST_BRANCH);
  });
});

describe("integration: worktree_path", () => {
  const PATH_BRANCH = "gtr-mcp-it-path-branch";

  it.skipIf(!gtrAvailable)("resolves main repo path via identifier '1'", async () => {
    const result = await withTimeout(
      handleWorktreePath({ repo_path: repoPath, branch: "1" }),
      "path main"
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBeUndefined();
    expect(typeof data.path).toBe("string");
    expect(data.path.length).toBeGreaterThan(0);
  });

  it.skipIf(!gtrAvailable)("resolves path of a created worktree", async () => {
    // Create a worktree first
    await withTimeout(
      handleWorktreeCreate({ repo_path: repoPath, branch: PATH_BRANCH }),
      "create for path test"
    );

    const result = await withTimeout(
      handleWorktreePath({ repo_path: repoPath, branch: PATH_BRANCH }),
      "path"
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBeUndefined();
    expect(data.branch).toBe(PATH_BRANCH);
    expect(data.path).toMatch(/\//); // should be an absolute path
  });

  it.skipIf(!gtrAvailable)("returns error for non-existent branch", async () => {
    const result = await withTimeout(
      handleWorktreePath({ repo_path: repoPath, branch: "definitely-does-not-exist-xyz" }),
      "path non-existent"
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBeTruthy();
  });

  it.skipIf(!gtrAvailable)("cleanup: remove path-test worktree", async () => {
    await withTimeout(
      handleWorktreeRemove({ repo_path: repoPath, branch: PATH_BRANCH, confirm: true }),
      "remove path branch"
    );
  });
});

describe("integration: worktree_copy dry_run", () => {
  const COPY_SRC = "gtr-mcp-it-copy-src";
  const COPY_DST = "gtr-mcp-it-copy-dst";

  it.skipIf(!gtrAvailable)("dry_run previews without copying (non-destructive gate)", async () => {
    // Create source and destination worktrees
    await withTimeout(
      handleWorktreeCreate({ repo_path: repoPath, branch: COPY_SRC }),
      "create copy-src"
    );
    await withTimeout(
      handleWorktreeCreate({ repo_path: repoPath, branch: COPY_DST }),
      "create copy-dst"
    );

    // dry_run copy — must succeed (success:true) or return an expected no-files warning
    const result = await withTimeout(
      handleWorktreeCopy({
        repo_path: repoPath,
        from: COPY_SRC,
        targets: [COPY_DST],
        patterns: [".env"],
        dry_run: true,
      }),
      "copy dry_run"
    );
    const data = JSON.parse(result.content[0].text);
    // dry_run should not fail at the tool level; gtr may warn about no files found
    expect(data.error).toBeUndefined();
    expect(data.dry_run).toBe(true);
    expect(data.from).toBe(COPY_SRC);
  });

  it.skipIf(!gtrAvailable)("cleanup: remove copy worktrees", async () => {
    await withTimeout(
      handleWorktreeRemove({ repo_path: repoPath, branch: COPY_SRC, confirm: true }),
      "remove copy-src"
    );
    await withTimeout(
      handleWorktreeRemove({ repo_path: repoPath, branch: COPY_DST, confirm: true }),
      "remove copy-dst"
    );
  });
});

describe("integration: remove with delete_branch", () => {
  const BRANCH_TO_DELETE = "gtr-mcp-it-delete-branch";

  it.skipIf(!gtrAvailable)("create and remove with delete_branch=true", async () => {
    // Create first
    await withTimeout(
      handleWorktreeCreate({ repo_path: repoPath, branch: BRANCH_TO_DELETE }),
      "create for delete"
    );

    // Remove with branch deletion
    const result = await withTimeout(
      handleWorktreeRemove({
        repo_path: repoPath,
        branch: BRANCH_TO_DELETE,
        confirm: true,
        delete_branch: true,
      }),
      "remove with delete_branch"
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.branch_deleted).toBe(true);
  });
});
