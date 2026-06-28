import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  worktreeRemoveSchema,
  worktreeCleanSchema,
  worktreeCreateSchema,
  worktreeRenameSchema,
  worktreeStatusSchema,
  worktreePathSchema,
  worktreeCopySchema,
  worktreeListSchema,
} from "../tools/worktree.js";

// ---------------------------------------------------------------------------
// No repo_path anywhere — v0.4.0 cwd-native model
// ---------------------------------------------------------------------------

describe("no repo_path in any schema (cwd-native model)", () => {
  it("worktree_list parses empty input", () => {
    expect(worktreeListSchema.safeParse({}).success).toBe(true);
  });

  it("worktree_create does not require repo_path", () => {
    expect(
      worktreeCreateSchema.safeParse({ branch: "feat/x" }).success
    ).toBe(true);
  });

  it("worktree_remove does not require repo_path", () => {
    expect(
      worktreeRemoveSchema.safeParse({ branch: "feat/x", confirm: true }).success
    ).toBe(true);
  });

  it("worktree_status does not require repo_path", () => {
    expect(
      worktreeStatusSchema.safeParse({ branch: "feat/x" }).success
    ).toBe(true);
  });

  it("worktree_rename does not require repo_path", () => {
    expect(
      worktreeRenameSchema.safeParse({ old_branch: "old", new_branch: "new" }).success
    ).toBe(true);
  });

  it("worktree_path does not require repo_path", () => {
    expect(
      worktreePathSchema.safeParse({ branch: "feat/x" }).success
    ).toBe(true);
  });

  it("worktree_copy does not require repo_path", () => {
    expect(
      worktreeCopySchema.safeParse({ from: "main" }).success
    ).toBe(true);
  });

  it("worktree_clean does not require repo_path", () => {
    expect(
      worktreeCleanSchema.safeParse({}).success
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// worktree_remove confirm gate (real exported schema)
// ---------------------------------------------------------------------------

describe("worktree_remove confirm gate", () => {
  it("rejects missing confirm", () => {
    expect(
      worktreeRemoveSchema.safeParse({ branch: "b" }).success
    ).toBe(false);
  });

  it("rejects confirm=false", () => {
    expect(
      worktreeRemoveSchema.safeParse({ branch: "b", confirm: false }).success
    ).toBe(false);
  });

  it("rejects confirm='true' (string)", () => {
    expect(
      worktreeRemoveSchema.safeParse({ branch: "b", confirm: "true" }).success
    ).toBe(false);
  });

  it("rejects confirm=1 (number)", () => {
    expect(
      worktreeRemoveSchema.safeParse({ branch: "b", confirm: 1 }).success
    ).toBe(false);
  });

  it("accepts confirm=true (boolean)", () => {
    expect(
      worktreeRemoveSchema.safeParse({ branch: "b", confirm: true }).success
    ).toBe(true);
  });

  // Falsification: verify the real confirm gate is what blocks, not schema drift
  it("would fail without the confirm field in the real schema (anti-drift check)", () => {
    // If someone accidentally removed the z.literal(true) from worktreeRemoveSchema,
    // this test would pass with success:true even without confirm — confirming the gate
    const withoutConfirm = worktreeRemoveSchema.safeParse({ branch: "b" });
    expect(withoutConfirm.success).toBe(false);
    // Ensure the error is about the missing confirm, not something else
    const issues = withoutConfirm.error?.issues ?? [];
    const confirmIssue = issues.find((i) => i.path.includes("confirm"));
    expect(confirmIssue).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Lenient boolean coercion
// ---------------------------------------------------------------------------

describe("lenient coercion", () => {
  const schema = z.object({ force: z.coerce.boolean().optional() });

  it("coerces 'true' string to true", () => {
    expect(schema.parse({ force: "true" }).force).toBe(true);
  });

  it("coerces '1' string to true", () => {
    expect(schema.parse({ force: "1" }).force).toBe(true);
  });

  it("coerces 'false' string to true (non-empty string is truthy in JS)", () => {
    // z.coerce.boolean() uses Boolean() which treats any non-empty string as true.
    // If you need false-for-'false', use z.enum(['true','false']).transform(v => v === 'true') instead.
    expect(schema.parse({ force: "false" }).force).toBe(true);
  });

  it("coerces '0' string to true (non-empty string is truthy in JS)", () => {
    // z.coerce.boolean() uses Boolean("0") === true
    expect(schema.parse({ force: "0" }).force).toBe(true);
  });

  it("passes through boolean true as-is", () => {
    expect(schema.parse({ force: true }).force).toBe(true);
  });

  it("passes through boolean false as-is", () => {
    expect(schema.parse({ force: false }).force).toBe(false);
  });

  it("undefined stays undefined", () => {
    expect(schema.parse({}).force).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// worktree_clean confirm gate (real exported schema)
// ---------------------------------------------------------------------------

describe("worktree_clean confirm gate", () => {
  it("rejects merged=true, no dry_run, no confirm", () => {
    expect(
      worktreeCleanSchema.safeParse({ merged: true }).success
    ).toBe(false);
  });

  it("rejects closed=true, no dry_run, no confirm", () => {
    expect(
      worktreeCleanSchema.safeParse({ closed: true }).success
    ).toBe(false);
  });

  it("accepts merged=true with dry_run=true (no confirm needed)", () => {
    expect(
      worktreeCleanSchema.safeParse({ merged: true, dry_run: true }).success
    ).toBe(true);
  });

  it("accepts merged=true, confirm=true", () => {
    expect(
      worktreeCleanSchema.safeParse({ merged: true, confirm: true }).success
    ).toBe(true);
  });

  it("accepts closed=true, confirm=true", () => {
    expect(
      worktreeCleanSchema.safeParse({ closed: true, confirm: true }).success
    ).toBe(true);
  });

  it("accepts plain prune (no merged/closed) without confirm", () => {
    // Non-destructive path — just prune stale entries
    expect(
      worktreeCleanSchema.safeParse({}).success
    ).toBe(true);
  });

  it("accepts dry_run=true alone without confirm", () => {
    expect(
      worktreeCleanSchema.safeParse({ merged: true, closed: true, dry_run: true }).success
    ).toBe(true);
  });

  // Falsification: removing the refine from worktreeCleanSchema would make this fail
  it("confirms the refine is load-bearing (merged+no-confirm must reject)", () => {
    const result = worktreeCleanSchema.safeParse({ merged: true });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// z.literal(true) vs z.coerce.boolean() — they must NOT be mixed
// ---------------------------------------------------------------------------

describe("literal(true) strictness vs coerce.boolean", () => {
  const literalSchema = z.object({ confirm: z.literal(true) });
  const coerceSchema = z.object({ confirm: z.coerce.boolean() });

  it("literal(true) rejects '1' string (no coercion)", () => {
    expect(literalSchema.safeParse({ confirm: "1" }).success).toBe(false);
  });

  it("coerce.boolean() accepts '1' string", () => {
    expect(coerceSchema.parse({ confirm: "1" }).confirm).toBe(true);
  });

  it("literal(true) accepts only the exact boolean true", () => {
    expect(literalSchema.safeParse({ confirm: true }).success).toBe(true);
    expect(literalSchema.safeParse({ confirm: false }).success).toBe(false);
    expect(literalSchema.safeParse({ confirm: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Option-injection guard: branch/ref names must not start with '-'
// ---------------------------------------------------------------------------

describe("option-injection guard on branch/ref names", () => {
  it("worktree_create rejects branch starting with '-'", () => {
    expect(
      worktreeCreateSchema.safeParse({ branch: "--force" }).success
    ).toBe(false);
  });

  it("worktree_create rejects from_ref starting with '-'", () => {
    expect(
      worktreeCreateSchema.safeParse({ branch: "main", from_ref: "--evil" }).success
    ).toBe(false);
  });

  it("worktree_create rejects folder with path separator", () => {
    expect(
      worktreeCreateSchema.safeParse({ branch: "main", folder: "../evil" }).success
    ).toBe(false);
  });

  it("worktree_create rejects folder starting with '-'", () => {
    expect(
      worktreeCreateSchema.safeParse({ branch: "main", folder: "-bad" }).success
    ).toBe(false);
  });

  it("worktree_create accepts normal branch", () => {
    expect(
      worktreeCreateSchema.safeParse({ branch: "feat/my-branch" }).success
    ).toBe(true);
  });

  it("worktree_create accepts normal folder", () => {
    expect(
      worktreeCreateSchema.safeParse({ branch: "main", folder: "my-worktree" }).success
    ).toBe(true);
  });

  it("worktree_remove rejects branch starting with '-'", () => {
    expect(
      worktreeRemoveSchema.safeParse({ branch: "--delete", confirm: true }).success
    ).toBe(false);
  });

  it("worktree_remove accepts normal branch with confirm", () => {
    expect(
      worktreeRemoveSchema.safeParse({ branch: "feat/x", confirm: true }).success
    ).toBe(true);
  });

  it("worktree_rename rejects old_branch starting with '-'", () => {
    expect(
      worktreeRenameSchema.safeParse({ old_branch: "--flag", new_branch: "ok" }).success
    ).toBe(false);
  });

  it("worktree_rename rejects new_branch starting with '-'", () => {
    expect(
      worktreeRenameSchema.safeParse({ old_branch: "ok", new_branch: "--flag" }).success
    ).toBe(false);
  });

  it("worktree_status rejects branch starting with '-'", () => {
    expect(
      worktreeStatusSchema.safeParse({ branch: "-C/etc" }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// worktree_path schema
// ---------------------------------------------------------------------------

describe("worktree_path schema", () => {
  it("accepts valid branch", () => {
    expect(
      worktreePathSchema.safeParse({ branch: "feat/my-branch" }).success
    ).toBe(true);
  });

  it("accepts numeric identifier '1' (main repo shorthand)", () => {
    expect(
      worktreePathSchema.safeParse({ branch: "1" }).success
    ).toBe(true);
  });

  it("rejects branch starting with '-' (option-injection guard)", () => {
    const result = worktreePathSchema.safeParse({ branch: "--force" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/option-injection guard/);
  });

  it("rejects missing branch", () => {
    expect(
      worktreePathSchema.safeParse({}).success
    ).toBe(false);
  });

  // Falsification: removing the refine would make the leading-dash case pass
  it("anti-drift: leading-dash rejection is load-bearing", () => {
    const withDash = worktreePathSchema.safeParse({ branch: "-evil" });
    expect(withDash.success).toBe(false);
    const withoutDash = worktreePathSchema.safeParse({ branch: "good" });
    expect(withoutDash.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// worktree_copy schema
// ---------------------------------------------------------------------------

describe("worktree_copy schema", () => {
  it("accepts minimal valid input (from only)", () => {
    expect(
      worktreeCopySchema.safeParse({ from: "main" }).success
    ).toBe(true);
  });

  it("accepts full valid input with patterns", () => {
    expect(
      worktreeCopySchema.safeParse({
        from: "main",
        targets: ["feat/x", "feat/y"],
        patterns: [".env", "config/*.json"],
        dry_run: true,
      }).success
    ).toBe(true);
  });

  it("accepts all=true without targets", () => {
    expect(
      worktreeCopySchema.safeParse({ from: "main", all: true }).success
    ).toBe(true);
  });

  it("defaults dry_run to false", () => {
    const result = worktreeCopySchema.safeParse({ from: "main" });
    expect(result.success).toBe(true);
    expect(result.data?.dry_run).toBe(false);
  });

  it("rejects from starting with '-' (option-injection guard)", () => {
    const result = worktreeCopySchema.safeParse({ from: "--evil" });
    expect(result.success).toBe(false);
  });

  it("rejects target starting with '-'", () => {
    const result = worktreeCopySchema.safeParse({
      from: "main",
      targets: ["-bad-target"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects pattern starting with '-'", () => {
    const result = worktreeCopySchema.safeParse({
      from: "main",
      patterns: ["--evil-flag"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects pattern containing '..' (path-traversal guard)", () => {
    const result = worktreeCopySchema.safeParse({
      from: "main",
      patterns: ["../../etc/passwd"],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/path-traversal guard/);
  });

  it("rejects pattern starting with '/' (absolute path guard)", () => {
    const result = worktreeCopySchema.safeParse({
      from: "main",
      patterns: ["/etc/passwd"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts patterns with relative dots that are safe (e.g. '.env')", () => {
    expect(
      worktreeCopySchema.safeParse({ from: "main", patterns: [".env"] }).success
    ).toBe(true);
  });

  it("accepts patterns like '*.local' and 'config/*.json'", () => {
    expect(
      worktreeCopySchema.safeParse({
        from: "main",
        patterns: ["*.local", "config/*.json"],
      }).success
    ).toBe(true);
  });

  // Falsification: removing the '..' refine would allow traversal patterns
  it("anti-drift: '..' rejection is load-bearing for traversal prevention", () => {
    const withTraversal = worktreeCopySchema.safeParse({
      from: "main",
      patterns: ["../secret"],
    });
    expect(withTraversal.success).toBe(false);
    const without = worktreeCopySchema.safeParse({
      from: "main",
      patterns: [".env"],
    });
    expect(without.success).toBe(true);
  });
});
