/**
 * FF-1 fitness function: verifies no shell-string execution exists in src/.
 *
 * Patterns rejected (any actual code, not comments or string literals):
 *   - shell: true         — passes a shell string to child_process options
 *   - execSync            — synchronous shell execution
 *   - exec`...`           — tagged-template shell execution
 *
 * False-positive exclusions (handled per line below):
 *   - Lines that are pure comments (//)
 *   - Lines where the match is inside a string literal ("..." or '...')
 *   - Lines from this file itself (ff-check.ts)
 *   - Prose references in JSDoc/comments ("NEVER use shell: true", "execSync")
 *
 * Security risk: shell-string execution lets user-controlled input reach the
 * OS shell parser, enabling command injection even when no shell: true is set
 * explicitly. NEVER introduce shell: true, execSync, or exec` in src/.
 */

import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, basename } from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// When run via tsx from src/, __dirname is src/. When run from dist/, __dirname
// is dist/. Either way we want to scan src/ only — use path.basename to detect.
const srcDir =
  basename(__dirname) === "src"
    ? __dirname
    : join(__dirname, "..", "src");

// NOTE: The string/comment exclusions below are a heuristic defense-in-depth backstop;
// the authoritative control is argv-only execFile calls (never shell:true) in production code.

/** Patterns that signal shell-string execution in production code. */
const PATTERNS = [
  // { shell: true } option object — matches "shell:" followed by optional whitespace then "true"
  /shell:\s*true/,
  // execSync call — synchronous blocking shell execution
  /execSync\s*\(/,
  // exec` tagged-template literal — bash-template-style execution
  /exec`/,
];

/**
 * Returns true if the match on this line is inside a comment or string literal.
 * inBlockComment indicates we entered a block comment on a previous line.
 */
function isFalsePositive(line: string, match: RegExpExecArray, inBlockComment: boolean): boolean {
  // If we're already inside a block comment from a previous line, the whole line is a comment
  if (inBlockComment) return true;

  const before = line.slice(0, match.index);

  // Pure line comment: everything before match is whitespace + "//"
  if (/^\s*\/\//.test(before)) return true;

  // Block comment line: e.g. " * NEVER uses shell: true"
  if (/^\s*\*/.test(before)) return true;

  // Inside a double-quoted or single-quoted string: odd number of unescaped quotes before match
  const doubleQuotes = (before.match(/(?<!\\)"/g) ?? []).length;
  const singleQuotes = (before.match(/(?<!\\)'/g) ?? []).length;
  if (doubleQuotes % 2 === 1) return true;
  if (singleQuotes % 2 === 1) return true;

  return false;
}

/** Track block comment state across lines. Returns updated inBlockComment. */
function updateBlockCommentState(line: string, inBlockComment: boolean): boolean {
  let state = inBlockComment;
  let i = 0;
  while (i < line.length - 1) {
    if (!state && line[i] === "/" && line[i + 1] === "*") {
      state = true;
      i += 2;
    } else if (state && line[i] === "*" && line[i + 1] === "/") {
      state = false;
      i += 2;
    } else {
      i++;
    }
  }
  return state;
}

let violations = 0;
interface DirentCompat {
  name: string;
  isFile(): boolean;
  parentPath?: string;
  path?: string;
}

const tsFiles = (
  fs.readdirSync(srcDir, { recursive: true, withFileTypes: true }) as unknown as DirentCompat[]
)
  // Filter to TypeScript source files; skip this file itself and test files
  .filter((entry) =>
    entry.isFile() &&
    entry.name.endsWith(".ts") &&
    entry.name !== basename(__filename) &&
    !entry.name.endsWith(".test.ts")
  )
  .map((entry) => {
    // parentPath is available in Node ≥ 20.12; older Node uses path
    const dir = entry.parentPath ?? entry.path ?? srcDir;
    return join(dir, entry.name);
  });

for (const filePath of tsFiles) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineInBlockComment = inBlockComment;
    inBlockComment = updateBlockCommentState(line, inBlockComment);

    for (const pattern of PATTERNS) {
      const re = new RegExp(pattern.source, "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        if (!isFalsePositive(line, match, lineInBlockComment)) {
          process.stderr.write(
            `FF-1 FAIL: ${filePath}:${i + 1}: ${line.trim()}\n`
          );
          violations++;
        }
      }
    }
  }
}

if (violations > 0) {
  process.stderr.write(`\nFF-1 FAIL: ${violations} shell execution violation(s) found\n`);
  process.exit(1);
}

// Verify grep is available as a sanity check (used by CI inline step)
try {
  execFileSync("grep", ["--version"], { stdio: "pipe" });
} catch {
  // grep not available — non-fatal, the AST check above is authoritative
}

console.log("FF-1 PASS: no shell execution found");
