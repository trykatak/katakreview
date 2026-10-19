import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guard the "no credential reaches stdout off a runner" invariant.
 *
 * `core.setSecret` / `saveState` / `setOutput` fall back to writing the raw
 * value to stdout when no runner is consuming them, so every credential-bearing
 * call has to be gated on `isGitHubActions`. That gate lived at 17 hand-written
 * call sites and five of them silently lacked it for months, which is how an
 * OpenAI key reached local agent transcripts and was disabled (2026-09).
 *
 * `action/utils/secretCommands.ts` now owns the gate. This refuses any other
 * call, so a new one fails here instead of leaking in someone's terminal.
 */
const actionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** the only module allowed to call the raw toolkit commands. */
const OWNER = "utils/secretCommands.ts";

/**
 * `setOutput` has one legitimate ungated caller: the agent's own `result` text
 * is not a credential, and the test harness reads it back through
 * `GITHUB_OUTPUT` on a host with no runner, so gating it would break the suite.
 */
const ALLOWED = new Map([["utils/runLifecycle.ts", new Set(["setOutput"])]]);

const COMMANDS = "setSecret|saveState|setOutput";

/** the namespaced call — `core.setSecret(…)`. */
const FORBIDDEN_CALL = new RegExp(`\\bcore\\.(${COMMANDS})\\s*\\(`, "g");

/**
 * The named-import spelling, which an IDE auto-import produces and which no
 * call-shape pattern can catch once the namespace qualifier is gone. Flagging
 * the import instead is both stricter and cheaper: nothing outside the owner
 * module has any business importing these three by name.
 */
const FORBIDDEN_IMPORT = new RegExp(
  `import\\s*\\{[^}]*\\b(${COMMANDS})\\b[^}]*\\}\\s*from\\s*["']@actions/core["']`,
  "g"
);

/**
 * Blank out comments so a doc block quoting one of these calls isn't a hit,
 * preserving newlines so reported line numbers still point at the source.
 *
 * String literals are matched first and left intact — otherwise the `//` in a
 * URL swallows the rest of its line, which silently hides any call sharing it.
 */
function stripComments(source: string): string {
  return source.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    /^["'`]/.test(match) ? match : match.replace(/[^\n]/g, " ")
  );
}

const violations: string[] = [];
for await (const entry of glob("**/*.ts", {
  cwd: actionDir,
  exclude: (name) => name === "node_modules" || name === "dist" || name.startsWith("."),
})) {
  const rel = entry.split("\\").join("/");
  if (rel === OWNER || rel.endsWith(".test.ts")) continue;
  const source = stripComments(readFileSync(resolve(actionDir, entry), "utf8"));
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  for (const match of source.matchAll(FORBIDDEN_CALL)) {
    const command = match[1];
    if (ALLOWED.get(rel)?.has(command)) continue;
    violations.push(`${rel}:${lineOf(match.index)} — core.${command}()`);
  }
  for (const match of source.matchAll(FORBIDDEN_IMPORT)) {
    violations.push(`${rel}:${lineOf(match.index)} — named import of a gated command`);
  }
}

if (violations.length > 0) {
  console.error(
    `secret-command guard failed. these bypass the ${OWNER} gate and print the raw value to stdout off a runner:`
  );
  for (const violation of violations.sort()) console.error(`- ${violation}`);
  console.error(`\nuse maskSecret / saveSecretState / setSecretOutput from ${OWNER} instead.`);
  process.exit(1);
}

console.log("secret-command guard passed");
