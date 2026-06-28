import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests drive real `gtr` subprocesses. Each individual tool
    // call has a 30s FF-2 budget (TOOL_TIMEOUT in integration.test.ts); a single
    // test may chain 2-3 such calls, so the per-test cap must sit ABOVE one tool
    // budget. vitest's default 5000ms is far too low — it kills chained-op tests
    // (and pre-empts the 30s FF-2 guard) on a loaded CI box.
    testTimeout: 60_000,
    // beforeAll provisions a temp git repo; give it the same per-call headroom.
    hookTimeout: 30_000,
  },
});
