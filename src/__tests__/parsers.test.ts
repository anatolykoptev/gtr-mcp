import { describe, it, expect } from "vitest";
import { parsePorcelainList, parseGitStatus } from "../gtr.js";

describe("parsePorcelainList", () => {
  it("parses basic two-worktree output, main first", () => {
    const raw = "/repo\tmain\tok\n/repo-worktrees/feat\tfeature/x\tok\n";
    const result = parsePorcelainList(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ path: "/repo", branch: "main", status: "ok", isMain: true });
    expect(result[1]).toMatchObject({ path: "/repo-worktrees/feat", branch: "feature/x", status: "ok", isMain: false });
  });

  it("handles single worktree (no linked)", () => {
    const raw = "/repo\tmain\t\n";
    const result = parsePorcelainList(raw);
    expect(result).toHaveLength(1);
    expect(result[0].isMain).toBe(true);
  });

  it("marks first entry isMain=true, rest false", () => {
    const raw = "/a\tbranch-a\tok\n/b\tbranch-b\tok\n/c\tbranch-c\tok\n";
    const result = parsePorcelainList(raw);
    expect(result[0].isMain).toBe(true);
    expect(result[1].isMain).toBe(false);
    expect(result[2].isMain).toBe(false);
  });

  it("handles backslash in branch name correctly (raw TSV, no escape)", () => {
    // Gate-0: gtr outputs raw real values (unescaped before printing).
    // A backslash in a branch name is passed through as-is in the TSV.
    // No un-escape logic needed — split("\t") is already correct.
    const raw = "/repo\tbranch\\with\\backslash\tok\n";
    const result = parsePorcelainList(raw);
    expect(result[0].branch).toBe("branch\\with\\backslash");
  });

  it("handles 'n' character sequences in branch (not escape codes)", () => {
    // If branch is literally "feat\nfoo" as two chars backslash+n (not a newline),
    // gtr unescapes internally and then outputs the raw value.
    // So the TSV contains the literal two-char sequence \n (backslash + n), not a newline.
    const raw = "/repo\tfeat\\nfoo\tok\n";
    const result = parsePorcelainList(raw);
    // We should see the literal backslash-n, NOT a newline character
    expect(result[0].branch).toBe("feat\\nfoo");
    expect(result[0].branch).not.toContain("\n");
  });

  it("returns empty array for empty input", () => {
    expect(parsePorcelainList("")).toEqual([]);
    expect(parsePorcelainList("   \n  \n")).toEqual([]);
  });

  it("skips malformed lines (< 2 fields)", () => {
    const raw = "/repo\n/ok\tbranch\tok\n";
    const result = parsePorcelainList(raw);
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("branch");
  });

  it("handles status field absent (2-column TSV)", () => {
    const raw = "/repo\tmain\n";
    const result = parsePorcelainList(raw);
    expect(result[0].status).toBe("");
  });

  it("trims whitespace from path and branch", () => {
    const raw = " /repo \t main \tok\n";
    const result = parsePorcelainList(raw);
    expect(result[0].path).toBe("/repo");
    expect(result[0].branch).toBe("main");
  });
});

describe("parseGitStatus", () => {
  it("parses clean branch with upstream", () => {
    const raw = "## main...origin/main\n";
    const result = parseGitStatus(raw);
    expect(result.branch).toBe("main");
    expect(result.upstream).toBe("origin/main");
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
    expect(result.clean).toBe(true);
  });

  it("parses ahead/behind tracking info", () => {
    const raw = "## feat/x...origin/feat/x [ahead 3, behind 1]\n";
    const result = parseGitStatus(raw);
    expect(result.branch).toBe("feat/x");
    expect(result.upstream).toBe("origin/feat/x");
    expect(result.ahead).toBe(3);
    expect(result.behind).toBe(1);
  });

  it("handles detached HEAD", () => {
    const raw = "## HEAD (no branch)\n";
    const result = parseGitStatus(raw);
    expect(result.branch).toBe("(detached HEAD)");
    expect(result.upstream).toBeNull();
  });

  it("handles branch with no upstream (no tracking)", () => {
    const raw = "## main\n";
    const result = parseGitStatus(raw);
    expect(result.branch).toBe("main");
    expect(result.upstream).toBeNull();
  });

  it("handles 'No commits yet' case", () => {
    const raw = "## No commits yet on main\n";
    const result = parseGitStatus(raw);
    expect(result.branch).toBe("main");
    expect(result.upstream).toBeNull();
  });

  it("classifies staged, unstaged, untracked files", () => {
    const raw = [
      "## main...origin/main",
      "M  staged.ts",
      " M unstaged.ts",
      "MM both.ts",
      "?? new-file.ts",
    ].join("\n") + "\n";
    const result = parseGitStatus(raw);
    expect(result.staged).toContain("staged.ts");
    expect(result.staged).toContain("both.ts");
    expect(result.unstaged).toContain("unstaged.ts");
    expect(result.unstaged).toContain("both.ts");
    expect(result.untracked).toContain("new-file.ts");
  });

  it("clean=true when no staged/unstaged/untracked", () => {
    const raw = "## main...origin/main\n";
    const result = parseGitStatus(raw);
    expect(result.clean).toBe(true);
    expect(result.staged).toHaveLength(0);
    expect(result.unstaged).toHaveLength(0);
    expect(result.untracked).toHaveLength(0);
  });

  it("clean=false when there are staged files", () => {
    const raw = "## main\nM  foo.ts\n";
    const result = parseGitStatus(raw);
    expect(result.clean).toBe(false);
    expect(result.staged).toContain("foo.ts");
  });

  it("clean=false when there are untracked files", () => {
    const raw = "## main\n?? newfile.ts\n";
    const result = parseGitStatus(raw);
    expect(result.clean).toBe(false);
    expect(result.untracked).toContain("newfile.ts");
  });

  it("parses ahead-only tracking info", () => {
    const raw = "## main...origin/main [ahead 2]\n";
    const result = parseGitStatus(raw);
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(0);
  });

  it("parses behind-only tracking info", () => {
    const raw = "## main...origin/main [behind 5]\n";
    const result = parseGitStatus(raw);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(5);
  });
});
