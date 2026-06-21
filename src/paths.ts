/**
 * Path validation utilities (side-effect-free module, safe to import in tests).
 */

import path from "path";

/**
 * Validate that repoPath is within repoBase (if set).
 * Prevents an agent from redirecting operations to an arbitrary path.
 */
export function validateRepoBase(repoPath: string, repoBase: string): void {
  const resolved = path.resolve(repoPath);
  const base = path.resolve(repoBase);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(
      `repo_path "${repoPath}" is outside the allowed base directory "${repoBase}". ` +
        `Set GTR_MCP_REPO_BASE to a parent of the repo you want to use.`
    );
  }
}
