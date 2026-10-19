import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type CodexAuthBody, refreshCodexAuthBody, stringifyCodexAuthBody } from "./codexOAuth.ts";

/**
 * minted Codex subscription credential. raw `auth.json` body that Codex CLI /
 * OpenCode plugins consume. validated to be `auth_mode: "chatgpt"` with a
 * refresh token before being returned. caller is responsible for storing it
 * (typically as the `CODEX_AUTH_JSON` Pullfrog secret).
 */
export interface CodexAuth {
  /** raw JSON body of the minted `auth.json`; safe to persist verbatim. */
  json: string;
  /** parsed for caller convenience; mirrors the shape Codex CLI writes. */
  parsed: CodexAuthJson;
}

export type CodexAuthJson = CodexAuthBody;

/** force one refresh round-trip against the OAuth provider so the saved
 * credential carries the freshest refresh token. used right after `codex
 * login` and again any time we want to bump the chain before
 * persisting (avoids the user's laptop refreshing first and burning ours).
 * Server-side rotation at run-context uses `refreshCodexAuthBody` directly. */
export async function refreshCodexAuth(auth: CodexAuth): Promise<CodexAuth> {
  const refreshed = await refreshCodexAuthBody(auth.parsed);
  return { json: stringifyCodexAuthBody(refreshed), parsed: refreshed };
}

export type ProgressEvent =
  | { kind: "start"; attempt: number }
  | { kind: "exit"; exitCode: number; signal: NodeJS.Signals | null; timedOut: boolean }
  | { kind: "retry"; reason: "user-request" | "no-auth-written" }
  | { kind: "cancel" };

interface RunOptions {
  /** sign in with a one-time code instead of Codex's browser redirect to
   * localhost — the only login that works when the browser is on another machine. */
  deviceAuth: boolean;
  /** abort the whole flow when true is returned. polled before each retry. */
  shouldRetry: () => Promise<boolean>;
  /** observe progress for UI rendering. */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * pass-through control over the child's stdio. `inherit` streams Codex's
   * own UI directly to the user's terminal. `pipe` is what `pullfrog auth
   * codex` uses so it can re-render each line with a Pullfrog-styled rail
   * + dim formatting via `onChildLine`.
   */
  childStdio?: "inherit" | "pipe";
  /**
   * called once per line of Codex's stdout/stderr when `childStdio` is
   * "pipe". raw line text is passed through unmodified (including any ANSI
   * escapes Codex emitted); the caller is responsible for stripping/styling.
   */
  onChildLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** how long a single login attempt is allowed to run. */
  perAttemptTimeoutMs?: number;
}

/**
 * mint a fresh Codex subscription credential by running `codex login`
 * against an isolated `CODEX_HOME`. the user's global
 * `~/.codex/auth.json` is never touched; on success or failure, the
 * temporary home is cleaned up.
 *
 * the caller controls retry behavior via `shouldRetry`: when the login
 * exits without writing `auth.json` (under `deviceAuth`, most commonly because
 * the user needed to enable device-code auth on their ChatGPT account first),
 * the function invokes `shouldRetry()` to decide whether to spin up another attempt.
 */
export async function mintCodexAuth(options: RunOptions): Promise<CodexAuth> {
  // mkdtempSync already creates the dir with the default 0o700 perms on
  // posix; an extra mkdirSync would just be ceremony.
  const codexHome = mkdtempSync(join(tmpdir(), "pullfrog-codex-"));
  try {
    // the login needs file-backed credentials; otherwise Codex routes the
    // refresh token into the OS keyring and we can't observe / persist it.
    writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', {
      mode: 0o600,
    });

    const authPath = join(codexHome, "auth.json");
    let attempt = 1;

    while (true) {
      options.onProgress?.({ kind: "start", attempt });
      const result = await runCodexLogin({
        codexHome,
        deviceAuth: options.deviceAuth,
        timeoutMs: options.perAttemptTimeoutMs ?? 15 * 60 * 1000,
        childStdio: options.childStdio ?? "inherit",
        onChildLine: options.onChildLine,
      });
      options.onProgress?.({
        kind: "exit",
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
      });

      const auth = readAuthIfPresent(authPath);
      if (auth) return auth;

      if (!(await options.shouldRetry())) {
        options.onProgress?.({ kind: "cancel" });
        throw new Error("Codex login did not produce auth.json (no retry requested)");
      }
      options.onProgress?.({ kind: "retry", reason: "no-auth-written" });
      attempt += 1;
    }
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

interface CodexLoginResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  /** true if the attempt was killed by our per-attempt timeout (vs. exited
   * naturally or was interrupted by the user). lets callers distinguish
   * "user walked away" from "user closed the login early". */
  timedOut: boolean;
}

interface CodexLoginInput {
  codexHome: string;
  deviceAuth: boolean;
  timeoutMs: number;
  childStdio: "inherit" | "pipe";
  onChildLine?: ((line: string, stream: "stdout" | "stderr") => void) | undefined;
}

/** how long to wait between SIGTERM and SIGKILL when killing a stuck `codex`
 * subprocess. Codex usually exits cleanly on SIGTERM, but if it ignores it we
 * don't want the CLI pinned forever. */
const SIGTERM_GRACE_MS = 5_000;

/** what Windows falls back to when `PATHEXT` is unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Windows environment variables are case-insensitive and it spells them `Path`
 * and `ComSpec`. `process.env` honours that; a plain object — a spread copy, or
 * an env a caller built — does not, and silently reads back undefined. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** the command processor, by absolute path. a bare `cmd.exe` would lean on the
 * very PATH resolution this module exists to stop relying on, and `spawn` finds
 * nothing when `PATH` is narrowed. */
function commandProcessor(env: NodeJS.ProcessEnv): string {
  return (
    envValue(env, "ComSpec") ??
    join(envValue(env, "SystemRoot") ?? "C:\\Windows", "system32", "cmd.exe")
  );
}

/** a resolved command, ready to hand to `spawn`. */
interface SpawnTarget {
  file: string;
  args: string[];
  /** the real process sits behind a `cmd.exe` wrapper, so a signal aimed at
   * the child reaches only the wrapper. */
  wrapped: boolean;
}

/**
 * resolve a bare command the way a Windows *shell* would, which is not how
 * `spawn` does it. Node's PATH search is libuv's `path_search_walk_ext`: it
 * tries the name, then `.com`, then `.exe`, and never reads `PATHEXT`.
 * `@openai/codex` installs as a `codex.cmd` shim, so `spawn("codex")` is ENOENT
 * on a machine where `codex --version` works in every shell.
 *
 * POSIX resolves bare names correctly already and keeps the plain spawn.
 */
export function resolveSpawnTarget(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): SpawnTarget | null {
  if (process.platform !== "win32") {
    return { file: params.command, args: params.args, wrapped: false };
  }

  const extensions = (envValue(params.env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .filter(Boolean);
  for (const directory of (envValue(params.env, "PATH") ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${params.command}${extension.toLowerCase()}`);
      // `existsSync` swallows EACCES on a PATH entry we can't read, which is
      // what we want: keep walking, exactly as libuv's own search does.
      if (!existsSync(candidate)) continue;
      if (!/\.(cmd|bat)$/i.test(candidate)) {
        return { file: candidate, args: params.args, wrapped: false };
      }
      // Node refuses to spawn a .bat/.cmd directly since CVE-2024-27980, so a
      // shim must go through the command processor. the OUTER quote pair is
      // what `/s` strips, leaving the inner quoted path intact — without it a
      // path containing a space runs nothing at all, which is the common case
      // under `C:\Users\First Last`. same shape Node's own `shell: true` emits.
      // every argument here is a compile-time constant, so there is nothing to
      // escape beyond that.
      const command = [`"${candidate}"`, ...params.args].join(" ");
      return {
        file: commandProcessor(params.env),
        args: ["/d", "/s", "/c", `"${command}"`],
        wrapped: true,
      };
    }
  }
  return null;
}

/** on Windows a shell finding `codex` proves nothing about `spawn`, so name the
 * extensions actually searched rather than telling a user whose PATH is already
 * correct to reinstall. */
function codexNotFoundMessage(env: NodeJS.ProcessEnv): string {
  const install =
    "install it with `npm i -g @openai/codex` or see https://developers.openai.com/codex/cli for other install options.";
  if (process.platform !== "win32") return `codex CLI not found on PATH. ${install}`;
  const extensions = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .filter(Boolean)
    .join(" ");
  return `codex CLI not found on PATH (searched every PATH entry for codex with ${extensions}). a working \`codex --version\` in a shell does not prove Node can spawn it. ${install}`;
}

/** spawn `codex login` with stdin closed so Codex doesn't hang
 * waiting for input. by default inherits stdout/stderr so the user sees the
 * sign-in URL (and, under `deviceAuth`, the one-time code) Codex prints; when `pipe`d, lines are forwarded
 * to `onChildLine` so the caller can re-style them. on per-attempt timeout,
 * sends SIGTERM and escalates to SIGKILL after a short grace.
 */
function runCodexLogin(input: CodexLoginInput): Promise<CodexLoginResult> {
  return new Promise((resolve, reject) => {
    const target = resolveSpawnTarget({
      command: "codex",
      args: input.deviceAuth ? ["login", "--device-auth"] : ["login"],
      env: process.env,
    });
    if (!target) {
      reject(new Error(codexNotFoundMessage(process.env)));
      return;
    }

    const child = spawn(target.file, target.args, {
      env: { ...process.env, CODEX_HOME: input.codexHome },
      stdio: ["ignore", input.childStdio, input.childStdio],
      windowsVerbatimArguments: target.wrapped,
      windowsHide: true,
    });

    if (input.childStdio === "pipe") {
      const onLine = input.onChildLine ?? (() => {});
      if (child.stdout) pipeLines(child.stdout, (line) => onLine(line, "stdout"));
      if (child.stderr) pipeLines(child.stderr, (line) => onLine(line, "stderr"));
    }

    let killTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      // behind `cmd.exe` a signal reaches only the wrapper, leaving the real
      // Codex process orphaned. `taskkill /t` takes the whole tree.
      if (target.wrapped && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        return;
      }
      child.kill("SIGTERM");
      // give Codex a grace window to exit cleanly on SIGTERM. if it ignores
      // it, force SIGKILL so we don't pin the CLI on a stuck child.
      killTimer = setTimeout(() => child.kill("SIGKILL"), SIGTERM_GRACE_MS);
    }, input.timeoutMs);

    // `spawn` emits 'error' (not 'close') when the binary can't be found
    // (ENOENT) or otherwise fails to start. without a listener, Node crashes
    // the process with an unhandled 'error' event.
    child.on("error", (err) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      const errno = err as NodeJS.ErrnoException;
      const message =
        errno.code === "ENOENT"
          ? codexNotFoundMessage(process.env)
          : `failed to spawn codex: ${errno.message}`;
      reject(new Error(message));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: code ?? 1, signal, timedOut });
    });
  });
}

/** byte-stream → newline-delimited line callback. emits any final partial
 * line on stream end so trailing content (e.g. a prompt with no newline)
 * still surfaces to the renderer.
 */
function pipeLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      onLine(line);
      idx = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      onLine(buffer);
      buffer = "";
    }
  });
}

function readAuthIfPresent(authPath: string): CodexAuth | null {
  let raw: string;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isCodexAuthJson(parsed)) return null;
  return { json: raw, parsed };
}

function isCodexAuthJson(value: unknown): value is CodexAuthJson {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.auth_mode !== "chatgpt") return false;
  const tokens = v.tokens;
  if (!tokens || typeof tokens !== "object") return false;
  const t = tokens as Record<string, unknown>;
  if (typeof t.access_token !== "string" || t.access_token.length === 0) return false;
  if (typeof t.refresh_token !== "string" || t.refresh_token.length === 0) return false;
  return true;
}
