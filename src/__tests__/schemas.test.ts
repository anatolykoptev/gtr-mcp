import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  worktreeRemoveSchema,
  worktreeCleanSchema,
  worktreeCreateSchema,
  worktreeRenameSchema,
  worktreeStatusSchema,
} from "../tools/worktree.js";

// ---------------------------------------------------------------------------
// worktree_remove confirm gate (real exported schema)
// ---------------------------------------------------------------------------

describe("worktree_remove confirm gate", () => {
  it("rejects missing confirm", () => {
    expect(
      worktreeRemoveSchema.safeParse({ repo_path: "/r", branch: "b" }).success
    ).toBe(false);
  });

  it("rejects confirm=false", () => {
    expect(
      worktreeRemoveSchema.safeParse({ repo_path: "/r", branch: "b", confirm: false }).success
    ).toBe(false);
  });

  it("rejects confirm='true' (string)", () => {
    expect(
      worktreeRemoveSchema.safeParse({ repo_path: "/r", branch: "b", confirm: "true" }).success
    ).toBe(false);
  });

  it("rejects confirm=1 (number)", () => {
    expect(
      worktreeRemoveSchema.safeParse({ repo_path: "/r", branch: "b", confirm: 1 }).success
    ).toBe(false);
  });

  it("accepts confirm=true (boolean)", () => {
    expect(
      worktreeRemoveSchema.safeParse({ repo_path: "/r", branch: "b", confirm: true }).success
    ).toBe(true);
  });

  // Falsification: verify the real confirm gate is what blocks, not schema drift
  it("would fail without the confirm field in the real schema (anti-drift check)", () => {
    // If someone accidentally removed the z.literal(true) from worktreeRemoveSchema,
    // this test would pass with success:true even without confirm — confirming the gate
    const withoutConfirm = worktreeRemoveSchema.safeParse({ repo_path: "/r", branch: "b" });
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
      worktreeCleanSchema.safeParse({ repo_path: "/r", merged: true }).success
    ).toBe(false);
  });

  it("rejects closed=true, no dry_run, no confirm", () => {
    expect(
      worktreeCleanSchema.safeParse({ repo_path: "/r", closed: true }).success
    ).toBe(false);
  });

  it("accepts merged=true with dry_run=true (no confirm needed)", () => {
    expect(
      worktreeCleanSchema.safeParse({ repo_path: "/r", merged: true, dry_run: true }).success
    ).toBe(true);
  });

  it("accepts merged=true, confirm=true", () => {
    expect(
      worktreeCleanSchema.safeParse({ repo_path: "/r", merged: true, confirm: true }).success
    ).toBe(true);
  });

  it("accepts closed=true, confirm=true", () => {
    expect(
      worktreeCleanSchema.safeParse({ repo_path: "/r", closed: true, confirm: true }).success
    ).toBe(true);
  });

  it("accepts plain prune (no merged/closed) without confirm", () => {
    // Non-destructive path — just prune stale entries
    expect(
      worktreeCleanSchema.safeParse({ repo_path: "/r" }).success
    ).toBe(true);
  });

  it("accepts dry_run=true alone without confirm", () => {
    expect(
      worktreeCleanSchema.safeParse({ repo_path: "/r", merged: true, closed: true, dry_run: true }).success
    ).toBe(true);
  });

  // Falsification: removing the refine from worktreeCleanSchema would make this fail
  it("confirms the refine is load-bearing (merged+no-confirm must reject)", () => {
    const result = worktreeCleanSchema.safeParse({ repo_path: "/r", merged: true });
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
      worktreeCreateSchema.safeParse({ repo_path: "/r", branch: "--force" }).success
    ).toBe(false);
  });

  it("worktree_create rejects from_ref starting with '-'", () => {
    expect(
      worktreeCreateSchema.safeParse({ repo_path: "/r", branch: "main", from_ref: "--evil" }).success
    ).toBe(false);
  });

  it("worktree_create rejects folder with path separator", () => {
    expect(
      worktreeCreateSchema.safeParse({ repo_path: "/r", branch: "main", folder: "../evil" }).success
    ).toBe(false);
  });

  it("worktree_create rejects folder starting with '-'", () => {
    expect(
      worktreeCreateSchema.safeParse({ repo_path: "/r", branch: "main", folder: "-bad" }).success
    ).toBe(false);
  });

  it("worktree_create accepts normal branch", () => {
    expect(
      worktreeCreateSchema.safeParse({ repo_path: "/r", branch: "feat/my-branch" }).success
    ).toBe(true);
  });

  it("worktree_create accepts normal folder", () => {
    expect(
      worktreeCreateSchema.safeParse({ repo_path: "/r", branch: "main", folder: "my-worktree" }).success
    ).toBe(true);
  });

  it("worktree_remove rejects branch starting with '-'", () => {
    expect(
      worktreeRemoveSchema.safeParse({ repo_path: "/r", branch: "--delete", confirm: true }).success
    ).toBe(false);
  });

  it("worktree_remove accepts normal branch with confirm", () => {
    expect(
      worktreeRemoveSchema.safeParse({ repo_path: "/r", branch: "feat/x", confirm: true }).success
    ).toBe(true);
  });

  it("worktree_rename rejects old_branch starting with '-'", () => {
    expect(
      worktreeRenameSchema.safeParse({ repo_path: "/r", old_branch: "--flag", new_branch: "ok" }).success
    ).toBe(false);
  });

  it("worktree_rename rejects new_branch starting with '-'", () => {
    expect(
      worktreeRenameSchema.safeParse({ repo_path: "/r", old_branch: "ok", new_branch: "--flag" }).success
    ).toBe(false);
  });

  it("worktree_status rejects branch starting with '-'", () => {
    expect(
      worktreeStatusSchema.safeParse({ repo_path: "/r", branch: "-C/etc" }).success
    ).toBe(false);
  });
});
