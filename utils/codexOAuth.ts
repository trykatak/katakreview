/**
 * Pure-stdlib (fetch) Codex OAuth refresh.
 *
 * Lives here (not in codexAuth.ts) so the Next.js server side can import it
 * via pullfrog/internal without dragging in node:child_process / spawn /
 * mkdtemp from the rest of codexAuth.ts. Used by:
 *   - action/utils/codexAuth.ts (re-exports refreshCodexAuthBody)
 *   - utils/codexSecretRotation.ts (server-side maybeRotate at run-context)
 *
 * See wiki/codex-auth.md for the end-to-end refresh lifecycle.
 */

// `decodeJwtExpMs` + `OAuthInvalidGrantError` moved to ./oauthShared.ts when
// the Grok chain landed — both providers need them. re-exported so importers
// (pullfrog/internal, codexHome, codexSecretRotation) keep working.
import { decodeJwtExpMs, OAuthInvalidGrantError, parseOAuthErrorBody } from "./oauthShared.ts";

export { decodeJwtExpMs, OAuthInvalidGrantError };

export interface CodexAuthBody {
  auth_mode: "chatgpt";
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  /**
   * ISO timestamp of a rejection OpenAI attributed to the token itself (a `401`
   * other than `invalid_client` — see `codexChainIsDead`). OpenAI rotates the refresh
   * token on every use, so such a rejection is PERMANENT — without a latch the
   * server re-issued the identical doomed refresh on every run (455 futile
   * round trips in 7 days, one per run, each holding a Postgres row lock across
   * a 10s external call). Cleared implicitly: `pullfrog auth codex` and
   * `PUT /api/runtime/secret` write a fresh blob without it, which re-arms
   * rotation. Never reaches `auth.json` — `installCodexAuth` builds that file
   * from explicit fields. See [#1101](https://github.com/pullfrog/app/issues/1101).
   */
  refresh_rejected_at?: string;
}

/** OAuth client id Codex CLI and OpenCode both use against `auth.openai.com`.
 * Same chain — a refresh token minted via `codex login` can be
 * refreshed against this client_id. */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
}

/** OpenAI does NOT answer RFC 6749 codes here: `error` is an OBJECT, when there is a body at
 * all. Measured with negative controls, a spent refresh answers `401 code:"token_expired"`, a
 * bad `grant_type` `400 code: null` and an unknown client `401 code:"invalid_client"` — but the
 * chains production latched answered `401` with an EMPTY body, so keying on `token_expired`
 * never fired the latch (#1101). A `401` is dead unless it blames our client id — codex-rs latches
 * every `401` with no such carve-out, so this is the stricter of the two. */
function codexChainIsDead(status: number, body: string): boolean {
  if (status !== 401) return false;
  const err = parseOAuthErrorBody(body)?.error;
  return !(err && typeof err === "object" && "code" in err && err.code === "invalid_client");
}

/** force one refresh round-trip against the OAuth provider. returns the
 * rotated Codex-shaped blob (the auth.json body verbatim). does NOT persist
 * — caller is responsible for writing back to wherever the token lives.
 *
 * server-side callers (maybeRotateCodexSecret) hold a DB row lock around
 * this call so concurrent runs serialize: first one rotates, subsequent
 * ones see the fresh value and skip. The 10s timeout is critical for that
 * use: it caps how long a stalled auth.openai.com holds the row lock,
 * keeping us well under the enclosing 30s transaction budget so the lock
 * always releases and queued callers get a turn instead of timing out on
 * the tx wrapper. Real OAuth latency is sub-second; 10s is generous. */
export async function refreshCodexAuthBody(body: CodexAuthBody): Promise<CodexAuthBody> {
  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: body.tokens.refresh_token,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status >= 400 && response.status < 500) {
      throw new OAuthInvalidGrantError(
        "Codex",
        response.status,
        text,
        codexChainIsDead(response.status, text)
      );
    }
    throw new Error(`Codex token refresh failed: ${response.status} ${text}`);
  }
  const tokens = (await response.json()) as OAuthTokenResponse;
  const idToken = tokens.id_token ?? body.tokens.id_token;
  const accountId = body.tokens.account_id;
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      ...(idToken ? { id_token: idToken } : {}),
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
}

/** parse + validate a Codex auth.json body from its JSON-string form.
 * returns null on any shape mismatch — caller treats as "no codex auth". */
export function parseCodexAuthBody(raw: string): CodexAuthBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const v = parsed as Record<string, unknown>;
  if (v.auth_mode !== "chatgpt") return null;
  const tokens = v.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const t = tokens as Record<string, unknown>;
  if (typeof t.access_token !== "string" || t.access_token.length === 0) return null;
  if (typeof t.refresh_token !== "string" || t.refresh_token.length === 0) return null;
  return {
    auth_mode: "chatgpt",
    ...(typeof v.refresh_rejected_at === "string"
      ? { refresh_rejected_at: v.refresh_rejected_at }
      : {}),
    tokens: {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      ...(typeof t.id_token === "string" ? { id_token: t.id_token } : {}),
      ...(typeof t.account_id === "string" ? { account_id: t.account_id } : {}),
    },
    ...(typeof v.last_refresh === "string" ? { last_refresh: v.last_refresh } : {}),
  };
}

/** serialize a CodexAuthBody to its canonical on-disk form. */
export function stringifyCodexAuthBody(body: CodexAuthBody): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}
