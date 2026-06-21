/**
 * Security invariant tests.
 *
 * Covers: validateRepoBase prefix-escape guard (src/paths.ts)
 * and detectHooksRan trust-skip detection (src/tools/worktree.ts).
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { validateRepoBase } from "../paths.js";
import { detectHooksRan } from "../tools/worktree.js";

describe("validateRepoBase prefix-escape guard", () => {
  const base = "/base/repos";

  it("accepts a repo directly inside base", () => {
    expect(() => validateRepoBase("/base/repos/my-repo", base)).not.toThrow();
  });

  it("accepts a repo nested deeper inside base", () => {
    expect(() => validateRepoBase("/base/repos/org/my-repo", base)).not.toThrow();
  });

  it("accepts exactly the base path itself", () => {
    expect(() => validateRepoBase("/base/repos", base)).not.toThrow();
  });

  it("rejects path traversal via '..'", () => {
    // /base/repos/../etc resolves to /base/etc — outside base
    expect(() => validateRepoBase("/base/repos/../etc", base)).toThrow(/outside the allowed base/);
  });

  it("rejects prefix attack: /baseEvil is not inside /base/repos", () => {
    // /baseEvil does not start with /base/repos/ and is not /base/repos itself
    expect(() => validateRepoBase("/baseEvil", base)).toThrow(/outside the allowed base/);
  });

  it("rejects sibling directory /base/other", () => {
    expect(() => validateRepoBase("/base/other", base)).toThrow(/outside the allowed base/);
  });

  it("rejects completely unrelated path", () => {
    expect(() => validateRepoBase("/etc/passwd", base)).toThrow(/outside the allowed base/);
  });

  it("rejects /base/repos-evil (common prefix attack)", () => {
    // /base/repos-evil starts with /base/repos but is NOT /base/repos + path.sep
    expect(() => validateRepoBase("/base/repos-evil", base)).toThrow(/outside the allowed base/);
  });

  it("rejects empty string", () => {
    // '' resolves to cwd, which is unlikely to be /base/repos
    // We just verify it doesn't silently pass
    const resolved = path.resolve("");
    const isInBase =
      resolved.startsWith(base + path.sep) || resolved === base;
    if (!isInBase) {
      expect(() => validateRepoBase("", base)).toThrow(/outside the allowed base/);
    }
  });
});

describe("detectHooksRan (gtr@ad7a3c5 string pinning)", () => {
  it("returns true when output contains no trust-skip signal", () => {
    expect(detectHooksRan("Worktree created: /path/to/wt\nHook completed\n")).toBe(true);
  });

  it("returns false on hooks.sh:202 message (phase skip)", () => {
    // gtr@ad7a3c5 lib/hooks.sh:202
    expect(detectHooksRan("Untrusted .gtrconfig hooks for 'postCreate' phase — skipping\n")).toBe(false);
  });

  it("returns false on config.sh:462 message (config skip)", () => {
    // gtr@ad7a3c5 lib/config.sh:462
    expect(detectHooksRan("Untrusted .gtrconfig copy.include skipped — run: git gtr trust\n")).toBe(false);
  });

  it("is case-insensitive (lowercased before match)", () => {
    expect(detectHooksRan("UNTRUSTED .GTRCONFIG hooks for 'postCreate' phase — skipping\n")).toBe(false);
  });

  it("returns true when output is empty (no hooks configured)", () => {
    expect(detectHooksRan("")).toBe(true);
  });
});
