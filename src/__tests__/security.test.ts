/**
 * Security invariant tests.
 *
 * Covers: detectHooksRan trust-skip detection (src/tools/worktree.ts).
 *
 * Note: validateRepoBase (src/paths.ts) was removed in v0.4.0 — the cwd
 * model eliminates per-call path arguments entirely. Path restriction is
 * handled at the OS/shell level by the MCP client's process configuration.
 */

import { describe, it, expect } from "vitest";
import { detectHooksRan } from "../tools/worktree.js";

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
