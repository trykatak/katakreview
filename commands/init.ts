import { execFileSync } from "node:child_process";
import * as p from "@clack/prompts";
import arg from "arg";
import pc from "picocolors";
import { KATAK_API_URL, pullfrogApi } from "./_shared.ts";

function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// ── helpers ──

// active spinner reference so bail/catch can clean up the terminal
let activeSpin: ReturnType<typeof p.spinner> | null = null;

function bail(msg: string): never {
  if (activeSpin) {
    activeSpin.stop(pc.red("failed"));
    activeSpin = null;
  }
  p.cancel(msg);
  process.exit(1);
}

function handleCancel<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    if (activeSpin) {
      activeSpin.stop(pc.red("canceled."));
      activeSpin = null;
    }
    p.cancel("canceled.");
    process.exit(0);
  }
}

function getGhToken(): string {
  let token: string;
  try {
    token = execFileSync("gh", ["auth", "token"], { encoding: "utf-8" }).trim();
  } catch {
    bail(
      `gh cli not found or not authenticated.\n` +
        `  ${pc.dim("install:")} https://cli.github.com\n` +
        `  ${pc.dim("then:")}    gh auth login`
    );
  }
  if (!token) {
    bail(
      `gh cli returned an empty token. try re-authenticating:\n` +
        `  ${pc.dim("run:")} gh auth login`
    );
  }
  return token;
}

type GhApiResult<T = unknown> = { data: T; scopes: string | null };

async function ghApi<T = unknown>(path: string, token: string): Promise<GhApiResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`github api ${path} returned ${response.status}: ${body}`);
    }

    const data = (await response.json().catch(() => {
      throw new Error(`github api ${path} returned non-JSON response`);
    })) as T;
    return { data, scopes: response.headers.get("x-oauth-scopes") };
  } finally {
    clearTimeout(timeout);
  }
}

function parseGitRemote(): { owner: string; repo: string } {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" }).trim();
  } catch {
    bail("not a git repository or no 'origin' remote found.");
  }

  const match = url.match(/github\.com(?::\d+)?[:/]+([^/]+)\/(.+?)(?:\.git)?(?:\/)?$/);
  if (!match) bail(`could not parse github owner/repo from remote: ${url}`);
  return { owner: match[1], repo: match[2] };
}

function openBrowser(url: string) {
  try {
    const platform = process.platform;
    if (platform === "darwin") execFileSync("open", [url], { stdio: "ignore" });
    else if (platform === "win32")
      execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    else execFileSync("xdg-open", [url], { stdio: "ignore" });
  } catch {
    // headless/SSH — user will open the URL manually
  }
}

// ── Pullfrog API ──

type SecretsApiData = {
  error?: string;
  appSlug?: string;
  installationId?: number | null;
  repositorySelection?: string | null;
  isOrg?: boolean;
};

type InstallationNotFound = {
  appSlug: string;
  installationId: number | null;
  repositorySelection: "all" | "selected" | null;
  isOrg: boolean;
};

type StatusResult =
  | { installed: true; installationId: number | null; isOrg: boolean }
  | ({ installed: false } & InstallationNotFound);

async function fetchStatus(ctx: {
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
    bail(errorMsg || `installation check failed (${result.status})`);
  }

  return {
    installed: true,
    isOrg: result.data.isOrg === true,
    installationId:
      typeof result.data.installationId === "number" ? result.data.installationId : null,
  };
}

// ── handoff ──

function installationConfigUrl(ctx: { owner: string; installationId: number; isOrg: boolean }) {
  return ctx.isOrg
    ? `https://github.com/organizations/${ctx.owner}/settings/installations/${ctx.installationId}`
    : `https://github.com/settings/installations/${ctx.installationId}`;
}

/**
 * Where the terminal hands off. `?repo=` is a hint the console consumes two
 * ways: a never-onboarded account gets it pre-selected in the setup wizard,
 * an established one is redirected straight to that repo's page.
 */
function consoleUrl(ctx: { owner: string; repo: string }) {
  return `${KATAK_API_URL}/console/${ctx.owner}?repo=${encodeURIComponent(ctx.repo)}`;
}

/**
 * `state` round-trips through github.com back to `/callback/github-app`, which
 * reads this form to land the installer on the console with the repo they ran
 * `init` in already selected. Owner is included so the callback can drop the
 * hint when the user installs on a different account than we detected.
 */
function installUrl(ctx: { appSlug: string; owner: string; repo: string }) {
  const state = encodeURIComponent(`cli:${ctx.owner}/${ctx.repo}`);
  return `https://github.com/apps/${ctx.appSlug}/installations/select_target?state=${state}`;
}

function printLink(url: string) {
  process.stdout.write(`${pc.gray(p.S_BAR)}    ${link(pc.dim(url), url)}\n`);
}

// ── main ──

async function main() {
  p.intro(pc.bgGreen(pc.black(" pullfrog ")));

  const spin = p.spinner();
  activeSpin = spin;

  // 1. authenticate
  spin.start("authenticating with github");
  const token = getGhToken();
  const userResult = await ghApi<{ login: string }>("/user", token);
  const user = userResult.data;

  // gho_ tokens from `gh auth login` expose scopes via x-oauth-scopes header.
  // fine-grained PATs (github_pat_) don't return scopes — they pass this check.
  // split on ", " and match exact scope — .includes("repo") would false-positive on "public_repo"
  //
  // kept after the handoff rewrite even though the only authenticated call left
  // is `GET /api/cli/secrets`: its server-side `getRepo` needs the scope for a
  // PRIVATE repo, and without it that 404 is indistinguishable from "app not
  // installed", so we'd send the user to re-install instead of to `gh auth
  // refresh`. over-strict for a public repo, but `gh auth login` grants `repo`.
  const scopeSet = userResult.scopes !== null ? new Set(userResult.scopes.split(", ")) : null;
  if (scopeSet !== null && !scopeSet.has("repo")) {
    bail(
      `your token is missing the ${pc.bold('"repo"')} scope.\n` +
        `  ${pc.dim("run:")} gh auth refresh --scopes repo\n` +
        `  ${pc.dim("then:")} npx pullfrog init`
    );
  }

  spin.stop(`hello, ${pc.cyan(`@${user.login}`)}`);

  // 2. detect repo
  spin.start("detecting repository");
  const remote = parseGitRemote();
  spin.stop(`detected repo ${pc.cyan(`${remote.owner}/${remote.repo}`)}`);

  // 3. ensure the app is installed, then hand off to the console — every
  // configuration decision (billing mode, provider, model, credential) and the
  // `pullfrog.yml` commit itself live there. The dashboard commits as the
  // signed-in user, so the workflow file is attributed to a human rather than
  // to pullfrog[bot], which is what the CLI's own installation token produced.
  spin.start("checking pullfrog app installation");
  const status = await fetchStatus({ token, owner: remote.owner, repo: remote.repo });
  const handoff = consoleUrl({ owner: remote.owner, repo: remote.repo });

  if (status.installed) {
    spin.stop(`pullfrog app is installed on ${pc.cyan(`@${remote.owner}`)}`);
    spin.start("");
    spin.stop("opening your dashboard");
    printLink(handoff);
    openBrowser(handoff);
    activeSpin = null;
    p.outro(
      `finish setup in your browser — ${pc.cyan(`${remote.owner}/${remote.repo}`)} is ready.`
    );
    return;
  }

  if (status.installationId) {
    const repoRef = pc.bold(`${remote.owner}/${remote.repo}`);
    const configUrl = installationConfigUrl({
      owner: remote.owner,
      installationId: status.installationId,
      isOrg: status.isOrg,
    });
    spin.stop(`pullfrog is installed on selected repos, but ${repoRef} is not included.`);
    p.log.info(
      `add it under "Repository access" on the installation config page.\n  ${pc.dim(configUrl)}`
    );
    const openIt = await p.confirm({ message: "open browser?", active: "yes", inactive: "no" });
    handleCancel(openIt);
    if (openIt) openBrowser(configUrl);
    p.log.info("once the repo is added, finish setup at:");
    printLink(handoff);
    activeSpin = null;
    p.outro("done.");
    return;
  }

  spin.stop("pullfrog app not installed");
  const install = installUrl({
    appSlug: status.appSlug,
    owner: remote.owner,
    repo: remote.repo,
  });
  p.log.info("opening browser to install...");
  printLink(install);
  openBrowser(install);
  activeSpin = null;
  p.outro("GitHub will drop you at your dashboard to finish setup.");
}

interface InitCliParams {
  args: string[];
  prog: string;
  showHelp?: boolean;
}

function printInitUsage(params: { stream: typeof console.log; prog: string }): void {
  params.stream(`usage: ${params.prog} init\n`);
  params.stream("install pullfrog on the current repository and open its dashboard.");
  params.stream("");
  params.stream("options:");
  params.stream("  -h, --help   show help");
}

function parseInitArgs(args: string[]) {
  return arg(
    {
      "--help": Boolean,
      "-h": "--help",
    },
    {
      argv: args,
    }
  );
}

export async function runCli(params: InitCliParams): Promise<void> {
  if (params.showHelp) {
    printInitUsage({ stream: console.log, prog: params.prog });
    return;
  }

  let parsed: ReturnType<typeof parseInitArgs>;
  try {
    parsed = parseInitArgs(params.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n`);
    printInitUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (parsed["--help"]) {
    printInitUsage({ stream: console.log, prog: params.prog });
    return;
  }

  if (parsed._.length > 0) {
    console.error(`unexpected positional arguments for init: ${parsed._.join(" ")}\n`);
    printInitUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  await run();
}

export async function run() {
  try {
    await main();
  } catch (error) {
    if (activeSpin) {
      activeSpin.stop(pc.red("failed"));
      activeSpin = null;
    }
    const msg =
      error instanceof Error && error.name === "AbortError"
        ? "request timed out — check your network connection and try again"
        : error instanceof Error
          ? error.message
          : String(error);
    p.log.error(msg);
    process.exit(1);
  }
}
