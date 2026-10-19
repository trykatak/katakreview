/**
 * Claude subscription sign-in without Claude Code: the PKCE flow `claude
 * setup-token` runs, on a loopback redirect, so `pullfrog auth claude` mints
 * the same one-year inference-only token (`sk-ant-oat01-…`) itself.
 *
 * Only the access token is kept, exactly what `claude setup-token` prints; the
 * refresh token the exchange also returns is dropped. See wiki/codex-auth.md
 * "Claude sibling".
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";

/** Claude Code's public OAuth client, the one `claude setup-token` signs in with. */
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** what makes the token a setup-token: inference only, valid for a year. */
const SETUP_TOKEN_SCOPE = "user:inference";
const SETUP_TOKEN_LIFETIME_S = 365 * 24 * 60 * 60;
const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  account: z.object({ email_address: z.string() }).optional(),
});

export interface ClaudeSetupToken {
  token: string;
  /** the account that signed in, as the token endpoint reports it. display only. */
  email: string | undefined;
}

/** run the sign-in end to end. `onUrl` receives the authorize URL once the
 * loopback listener is up; the promise settles when the browser comes back. */
export async function signInToClaude(params: {
  onUrl: (url: string) => void;
}): Promise<ClaudeSetupToken> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("hex");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no loopback port");
    const redirectUri = `http://localhost:${address.port}/callback`;

    const authorize = new URL(CLAUDE_AUTHORIZE_URL);
    authorize.search = new URLSearchParams({
      code: "true",
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SETUP_TOKEN_SCOPE,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
    }).toString();
    params.onUrl(authorize.toString());

    const code = await waitForCode({ server, state });
    return await exchangeCode({ code, verifier, state, redirectUri });
  } finally {
    server.close();
  }
}

/** resolve with the authorization code from the redirect carrying our `state`;
 * anything else (a favicon, a stale tab) gets a 404 and the wait goes on. */
function waitForCode(params: { server: Server; state: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Claude sign-in timed out after 15 minutes")),
      SIGN_IN_TIMEOUT_MS
    );
    params.server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback" || url.searchParams.get("state") !== params.state) {
        response.writeHead(404).end();
        return;
      }
      clearTimeout(timer);
      response
        .writeHead(200, { "content-type": "text/plain; charset=utf-8", connection: "close" })
        .end("Pullfrog received the sign-in. Return to the terminal.");
      const code = url.searchParams.get("code");
      if (code) resolve(code);
      else
        reject(new Error(`Claude sign-in failed: ${url.searchParams.get("error") ?? "no code"}`));
    });
  });
}

async function exchangeCode(params: {
  code: string;
  verifier: string;
  state: string;
  redirectUri: string;
}): Promise<ClaudeSetupToken> {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      code_verifier: params.verifier,
      state: params.state,
      expires_in: SETUP_TOKEN_LIFETIME_S,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Claude token exchange failed: ${response.status} ${text}`);
  }
  const body = tokenResponseSchema.parse(await response.json());
  return { token: body.access_token, email: body.account?.email_address };
}
