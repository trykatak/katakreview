import * as core from "@actions/core";
import { isGitHubActions } from "./globals.ts";

/**
 * `@actions/core` workflow commands that carry a credential, gated on actually
 * running under a runner.
 *
 * Off a runner nothing consumes these commands and `@actions/core` writes the
 * raw value to stdout instead — `setSecret` always, `saveState` / `setOutput`
 * whenever `GITHUB_STATE` / `GITHUB_OUTPUT` are unset. That is a plaintext
 * credential on whatever terminal is running the action, which is how an OpenAI
 * key reached local Codex transcripts and was disabled (2026-09).
 *
 * Route every credential-bearing call through here instead of calling `core`
 * directly — `nub run check:secret-commands` enforces it. Non-credential output
 * (the agent's own `result` text) stays ungated, because the test harness reads
 * it back through `GITHUB_OUTPUT` on a host with no runner.
 */
export function maskSecret(value: string): void {
  if (isGitHubActions) core.setSecret(value);
}

/** @see maskSecret — same gate, for state the `post:` hook reads back. */
export function saveSecretState(name: string, value: string): void {
  if (isGitHubActions) core.saveState(name, value);
}

/** @see maskSecret — same gate, for a step output carrying a credential. */
export function setSecretOutput(name: string, value: string): void {
  if (isGitHubActions) core.setOutput(name, value);
}
