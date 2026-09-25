// shared client for the PR event stream (`/api/cli/pr-events`), used by both
// `pullfrog watch` (daemon + `--once`) and the `pullfrog mcp` server.
//
// two things live here rather than in watch.ts because the MCP server needs
// them too: the poll call itself, and the on-disk cursor. the cursor is what
// makes a one-shot poll safe to call repeatedly — without it two consecutive
// `--once` calls silently drop everything that landed in the gap between them,
// and nothing on the client can detect that it happened.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLI_CONTRACT_HEADER,
  CLI_CONTRACT_VERSION,
  CLI_UPGRADE_MESSAGE,
  CliContractError,
} from "../cliContract.ts";
import { KATAK_API_URL } from "./_shared.ts";

export type StreamEvent = {
  cursor: string;
  repo: string;
  pr: number;
  kind: string;
  createdAt: string;
  data: Record<string, unknown>;
};

export type PollResult = { cursor: string; events: StreamEvent[] };

export type PrTarget = { owner: string; repo: string; pr: number };

/** per-request ceiling — must exceed the server long-poll window (~20s) so the
 * held connection returns normally rather than aborting client-side. */
const REQUEST_TIMEOUT_MS = 35_000;

/** the server's own long-poll budget, and so the granularity of any wait. keep
 * it at or below that budget: `waitForPrEvents` loops until this deadline, so a
 * value above it leaves enough time for a SECOND request — re-running the GitHub
 * authorization round-trip and the lease/sweep writes — only to abort it
 * mid-flight. at or below, the second iteration hits an already-fired abort
 * signal and never reaches the network. the server measures its budget from
 * request entry (app/api/cli/pr-events/route.ts). */
export const SERVER_POLL_WINDOW_MS = 20_000;

/**
 * terminal, non-retryable failures. these are thrown rather than exiting so
 * the MCP server can report them to the agent and stay up; `watch` translates
 * them into a CLI `bail`.
 */
export class PrEventsAuthError extends Error {}
export class PrEventsAccessError extends Error {}

/** an answer no retry can improve: the token is bad, or the repo is not ours to
 * read. everything else is worth another attempt. */
export function isTerminal(
  error: unknown
): error is PrEventsAuthError | PrEventsAccessError | CliContractError {
  return (
    error instanceof PrEventsAuthError ||
    error instanceof PrEventsAccessError ||
    error instanceof CliContractError
  );
}

export async function pollPrEvents(
  ctx: PrTarget & { token: string; cursor: string | undefined; signal?: AbortSignal }
): Promise<PollResult> {
  const params = new URLSearchParams({
    owner: ctx.owner,
    repo: ctx.repo,
    pr: String(ctx.pr),
  });
  if (ctx.cursor !== undefined) params.set("since", ctx.cursor);

  // two independent reasons to give up: our own per-request ceiling, and a
  // caller's overall deadline. wired by hand rather than with AbortSignal.any
  // so the published CLI keeps working below Node 20.3.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  if (ctx.signal?.aborted) controller.abort();
  else ctx.signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    const response = await fetch(`${KATAK_API_URL}/api/cli/pr-events?${params}`, {
      headers: {
        authorization: `Bearer ${ctx.token}`,
        [CLI_CONTRACT_HEADER]: CLI_CONTRACT_VERSION,
      },
      signal: controller.signal,
    });
    if (response.status === 426) throw new CliContractError(CLI_UPGRADE_MESSAGE);
    if (response.status === 401 || response.status === 403) {
      throw new PrEventsAuthError("invalid or expired github token — run `gh auth login`.");
    }
    if (response.status === 404) {
      throw new PrEventsAccessError(
        `repository ${ctx.owner}/${ctx.repo} not found or Pullfrog not installed on it.`
      );
    }
    if (!response.ok) {
      throw new Error(`pr-events returned ${response.status}`);
    }
    return (await response.json()) as PollResult;
  } finally {
    clearTimeout(timeout);
    ctx.signal?.removeEventListener("abort", onCallerAbort);
  }
}

// ── cursor store ──

function stateDir(): string {
  return process.env.KATAK_STATE_DIR || join(homedir(), ".pullfrog");
}

function cursorPath(target: PrTarget): string {
  const key = [target.owner, target.repo, String(target.pr)].map(encodeURIComponent).join("__");
  return join(stateDir(), "watch", `${key}.cursor`);
}

/** last cursor persisted for this PR, or undefined if this host has never
 * watched it. a malformed or unreadable file reads as absent — resubscribing
 * from now is always safe, where trusting a bad cursor is not. */
function readCursor(target: PrTarget): string | undefined {
  try {
    const raw = readFileSync(cursorPath(target), "utf-8").trim();
    return /^\d+$/.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** persist the cursor. best-effort: a read-only HOME degrades this to the
 * in-memory behaviour it replaced rather than killing a running watcher. */
export function writeCursor(target: PrTarget, cursor: string): void {
  try {
    const path = cursorPath(target);
    mkdirSync(join(stateDir(), "watch"), { recursive: true });
    writeFileSync(path, cursor, "utf-8");
  } catch {
    // ignore — a persisted cursor is an optimization, not a correctness gate.
  }
}

/**
 * resolve the cursor to start from, subscribing if this host has no stored
 * position. a fresh subscribe returns the current max seq and no events, so it
 * must NOT be treated as "nothing happened" — callers wanting to block for real
 * activity poll again with the returned cursor.
 */
export async function resolveCursor(
  ctx: PrTarget & { token: string; since: string | undefined }
): Promise<string> {
  if (ctx.since !== undefined) return ctx.since;
  const stored = readCursor(ctx);
  if (stored !== undefined) return stored;
  const subscribed = await pollPrEvents({ ...ctx, cursor: undefined });
  writeCursor(ctx, subscribed.cursor);
  return subscribed.cursor;
}

/**
 * block until new events land on the PR or `maxWaitMs` elapses, whichever comes
 * first. the server holds each request for its own ~20s window, so the deadline
 * has to cancel the request in flight rather than be checked between requests —
 * otherwise every wait rounds up to a full server window and a caller asking
 * for 8s waits the whole window.
 *
 * cancelling mid-hold loses nothing: the cursor only advances on a response we
 * actually received, so anything the server was about to send is still pending
 * for the next call.
 */
export async function waitForPrEvents(
  ctx: PrTarget & { token: string; cursor: string; maxWaitMs: number }
): Promise<PollResult> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), ctx.maxWaitMs);
  let cursor = ctx.cursor;
  try {
    for (;;) {
      const result = await pollPrEvents({ ...ctx, cursor, signal: controller.signal });
      cursor = result.cursor;
      if (result.events.length > 0) return { cursor, events: result.events };
    }
  } catch (error) {
    // the deadline firing is the one error we swallow. a bad token that lands
    // in the same tick must still surface, or a caller loops forever being told
    // the PR is quiet.
    if (isTerminal(error) || !controller.signal.aborted) throw error;
    return { cursor, events: [] };
  } finally {
    clearTimeout(deadline);
    writeCursor(ctx, cursor);
  }
}
