// shared helpers used by `init` and `auth` subcommands. these were originally
// inlined in `init.ts`; pulled out so `auth.ts` can reuse them without
// duplicating gh-auth/pullfrog-api/secret-save logic.

import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  CLI_CONTRACT_HEADER,
  CLI_CONTRACT_VERSION,
  CLI_UPGRADE_MESSAGE,
  CliContractError,
} from "../cliContract.ts";

export const KATAK_API_URL = (process.env.KATAK_API_URL || "https://pullfrog.com").replace(
  /\/+$/,
  ""
);

export const CODEX_AUTH_SECRET = "CODEX_AUTH_JSON";
export const CLAUDE_OAUTH_SECRET = "CLAUDE_CODE_OAUTH_TOKEN";
export const GROK_AUTH_SECRET = "GROK_AUTH_JSON";

/** the credentials `pullfrog auth` mints, derived from the three above so a new provider
 * cannot be wired into `auth` and silently miss the `secret set` guard. a repo's own copy of
 * one takes precedence over the account's AND the chain rotates, so a stale copy dies where it
 * sits. a static API key is deliberately not here: a repo copy shadowing one is what repo
 * scope is for. */
export const SUBSCRIPTION_SECRET_NAMES = [CODEX_AUTH_SECRET, CLAUDE_OAUTH_SECRET, GROK_AUTH_SECRET];

/** the refusal an account-level save earns while repos hold their own copy of `name`, or null
 * when none do. `auth` and `secret set` are two doors to the same write, so they share one
 * message — and it carries the commands rather than running them, because deleting a stored
 * credential is the owner's call. `overrides` is empty for a repo target, so this self-scopes. */
export function shadowRefusal(params: {
  overrides: { name: string; repo: string }[];
  owner: string;
  name: string;
}): string | null {
  const repos = params.overrides
    .filter((override) => override.name === params.name)
    .map((override) => `${params.owner}/${override.repo}`);
  if (!repos.length) return null;
  const bin = process.env.KATAK_BIN_NAME || "pullfrog";
  return [
    `${pc.cyan(params.name)} is already set on ${repos.map((repo) => pc.cyan(repo)).join(", ")}.`,
    `a repo's own copy takes precedence, so saving to ${pc.cyan(params.owner)} would not change`,
    `what runs there read.`,
    ``,
    `delete the repo copies, then run this command again:`,
    ...repos.map(
      (repo) => `  ${pc.cyan(`npx ${bin} secret delete ${params.name} --repo ${repo}`)}`
    ),
    ``,
    `${pc.dim("or:")} pass ${pc.cyan("--repo OWNER/REPO")} to replace one repo's own copy instead.`,
  ].join("\n");
}

// active spinner reference so bail/cancel can stop it before exiting. shared
// across init/auth subcommands via this module's singleton scope; whichever
// command starts a spinner sets this so handleCancel/bail can clean up.
let activeSpin: ReturnType<typeof p.spinner> | null = null;

export function setActiveSpin(spin: ReturnType<typeof p.spinner> | null): void {
  activeSpin = spin;
}

export function bail(msg: string): never {
  if (activeSpin) {
    activeSpin.stop(pc.red("failed"));
    activeSpin = null;
  }
  p.cancel(msg);
  process.exit(1);
}

export function handleCancel<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    if (activeSpin) {
      activeSpin.stop(pc.red("canceled."));
      activeSpin = null;
    }
    p.cancel("canceled.");
    process.exit(0);
  }
}

/** the gh token, or null when the cli is missing, unauthenticated, or silent.
 * the non-exiting half of `getGhToken` — `pullfrog mcp` speaks JSON-RPC over
 * stdout, so it cannot use a helper that exits through clack (which prints
 * there and would corrupt the stream). */
export function tryGetGhToken(): string | null {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

export const GH_TOKEN_HELP =
  "gh cli not found or not authenticated. install https://cli.github.com, then run `gh auth login`.";

export function getGhToken(): string {
  const token = tryGetGhToken();
  if (!token) {
    bail(
      `gh cli not found, not authenticated, or returned an empty token.\n` +
        `  ${pc.dim("install:")} https://cli.github.com\n` +
        `  ${pc.dim("then:")}    gh auth login`
    );
  }
  return token;
}

/** owner/repo from the `origin` remote, or null when there isn't one we can
 * parse. non-exiting twin of `parseGitRemote`, for the same stdout reason. */
export function tryParseGitRemote(): { owner: string; repo: string } | null {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
  const match = url.match(/github\.com(?::\d+)?[:/]+([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export function parseGitRemote(): { owner: string; repo: string } {
  const parsed = tryParseGitRemote();
  if (!parsed) {
    bail("not a git repository, no 'origin' remote, or the remote is not a github url.");
  }
  return parsed;
}

// ── Pullfrog API ──

type SecretsApiData = {
  error?: string;
  appSlug?: string;
  installationId?: number | null;
  repositorySelection?: string | null;
  isOrg?: boolean;
  accessible?: boolean;
  repoSecrets?: string[];
  orgSecrets?: string[];
  pullfrogSecrets?: string[];
  repoStatus?: string | null;
  repoModel?: string | null;
  hasRuns?: boolean;
};

type SecretsInfo = {
  isOrg: boolean;
  installationId: number | null;
  secretsAccessible: boolean;
  repoSecrets: string[];
  orgSecrets: string[];
  pullfrogSecrets: string[];
  model: string | null;
  hasRuns: boolean;
};

type InstallationNotFound = {
  appSlug: string;
  installationId: number | null;
  repositorySelection: "all" | "selected" | null;
  isOrg: boolean;
};

type StatusResult =
  | ({ installed: true } & SecretsInfo)
  | ({ installed: false } & InstallationNotFound);

type ApiResult<T = Record<string, unknown>> = {
  ok: boolean;
  status: number;
  data: T;
};

export async function pullfrogApi<T = Record<string, unknown>>(ctx: {
  path: string;
  token: string;
  method?: string | undefined;
  body?: object | undefined;
}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.token}`,
    [CLI_CONTRACT_HEADER]: CLI_CONTRACT_VERSION,
  };
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }
  if (ctx.body) headers["content-type"] = "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${KATAK_API_URL}${ctx.path}`, {
      method: ctx.method || "GET",
      headers,
      body: ctx.body ? JSON.stringify(ctx.body) : null,
      signal: controller.signal,
    });
    if (response.status === 426) throw new CliContractError(CLI_UPGRADE_MESSAGE);
    const data = (await response.json().catch(() => ({}))) as T;
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchStatus(ctx: {
  token: string;
  owner: string;
  repo: string;
}): Promise<StatusResult> {
  const result = await pullfrogApi<SecretsApiData>({
    path: `/api/cli/secrets?owner=${encodeURIComponent(ctx.owner)}&repo=${encodeURIComponent(ctx.repo)}`,
    token: ctx.token,
  });

  if (!result.ok) {
    const errorMsg = result.data.error || "";
    if (result.status === 401) bail("invalid or expired github token.");
    if (result.status === 404) {
      const sel = result.data.repositorySelection;
      if (!result.data.appSlug) bail("server did not return appSlug");
      return {
        installed: false,
        appSlug: result.data.appSlug,
        installationId:
          typeof result.data.installationId === "number" ? result.data.installationId : null,
        repositorySelection: sel === "all" || sel === "selected" ? sel : null,
        isOrg: result.data.isOrg === true,
      };
    }
    bail(errorMsg || `secrets check failed (${result.status})`);
  }

  return {
    installed: true,
    isOrg: result.data.isOrg === true,
    installationId:
      typeof result.data.installationId === "number" ? result.data.installationId : null,
    secretsAccessible: result.data.accessible !== false,
    repoSecrets: result.data.repoSecrets || [],
    orgSecrets: result.data.orgSecrets || [],
    pullfrogSecrets: result.data.pullfrogSecrets || [],
    model: result.data.repoModel ?? null,
    hasRuns: result.data.hasRuns === true,
  };
}

// ── secret save ──

export type SecretScope = "account" | "repo";

type PullfrogSecretResult = { saved: boolean; error: string };

export async function setPullfrogSecret(ctx: {
  token: string;
  owner: string;
  repo: string;
  name: string;
  value: string;
  scope: SecretScope;
}): Promise<PullfrogSecretResult> {
  const result = await pullfrogApi<{ success?: boolean; error?: string }>({
    path: "/api/cli/secrets",
    token: ctx.token,
    method: "POST",
    body: {
      owner: ctx.owner,
      repo: ctx.repo,
      name: ctx.name,
      value: ctx.value,
      scope: ctx.scope,
    },
  });
  if (result.ok && result.data.success === true) {
    return { saved: true, error: "" };
  }
  return { saved: false, error: result.data.error || `api returned ${result.status}` };
}

/** where a Pullfrog-stored secret actually lands, for CLI copy — the
 * account-level store is keyed to the repo owner, the repo-level store to the
 * repo itself. */
export function describeSecretTarget(ctx: {
  owner: string;
  repo: string;
  scope: SecretScope;
}): string {
  if (ctx.scope === "account") return `account ${pc.cyan(`@${ctx.owner}`)}`;
  return `repo ${pc.cyan(`${ctx.owner}/${ctx.repo}`)}`;
}

export async function promptScope(ctx: { owner: string; repo: string }): Promise<SecretScope> {
  const scope = await p.select<SecretScope>({
    message: "secret scope",
    options: [
      { value: "account", label: `${ctx.owner} organization`, hint: "shared across repos" },
      { value: "repo", label: `${ctx.owner}/${ctx.repo} only` },
    ],
  });
  handleCancel(scope);
  return scope;
}
