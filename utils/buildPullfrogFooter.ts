import {
  getModelProvider,
  isAutoTier,
  modelAliases,
  providers,
  resolveDisplayAlias,
} from "../models.ts";

export const KATAK_DIVIDER = "<!-- KATAK_DIVIDER_DO_NOT_REMOVE_PLZ -->";

// SELFHOST (katakpull): no upstream logo/branding — plain text attribution only.

export interface WorkflowRunFooterInfo {
  owner: string;
  repo: string;
  runId: number;
  /** optional job ID - if provided, will append /job/{jobId} to the workflow run URL */
  jobId?: string | undefined;
}

export interface BuildPullfrogFooterParams {
  /** add "via Pullfrog" link */
  triggeredBy?: boolean;
  /** add "View workflow run" link */
  workflowRun?: WorkflowRunFooterInfo | undefined;
  /** alternative: just pass a pre-built URL directly (for shortlinks etc.) */
  workflowRunUrl?: string | undefined;
  /** arbitrary custom parts (e.g., action links) */
  customParts?: string[] | undefined;
  /** model slug from payload (e.g., "anthropic/claude-opus"). shown in footer as "Using `Model Name`" */
  model?: string | undefined;
  /**
   * When a credential was rejected and the run moved to another model, this is
   * the slug the user had configured (e.g. "anthropic/claude-opus") — the footer
   * renders `Using <model> (credentials for <configured> were rejected by the
   * provider)` so the substitution is visible in PR comments + reviews.
   */
  fallbackFrom?: string | undefined;
  /**
   * When a Router account had a model (or the intelligent tier) selected that
   * the server clamped to the efficient default — custom picks are card-gated
   * wholesale. `from` is the configured slug (e.g. "anthropic/claude-opus");
   * `reason` names the binding constraint — "card" (no card on file) renders
   * `Using <Kimi K2> (<Claude Opus> needs a card on file)`, "noRouterPath"
   * (no openRouterResolve yet and no stored provider key) renders a
   * provider-key nudge — so the downgrade is visible rather than silently
   * presenting Kimi as the pick.
   */
  clamped?: { from: string; reason: "card" | "noRouterPath" | "oss" | "trial" } | undefined;
  /**
   * true when the run used the default proxy model only because no model was
   * selected (Router billing + "auto"). the footer appends a note nudging the
   * user to pick a model — the cost-optimized default is a weaker reviewer
   * than a frontier model.
   */
  unselectedProxyDefault?: boolean | undefined;
  /**
   * true when the run's model costs are covered by the Pullfrog for OSS
   * program — the footer renders `Using <model> (free via Pullfrog for OSS)`
   * with the phrase linking to the OSS application page.
   */
  oss?: boolean | undefined;
  /** repo owner, used to deep-link the trial disclosure at that account's own
   * console rather than the generic landing page. */
  owner?: string | undefined;
}

/** Provider display name (e.g. "Anthropic") for the slug, or the raw provider segment as a fallback. */
function providerDisplayName(slug: string): string {
  try {
    const key = getModelProvider(slug);
    const meta = providers[key as keyof typeof providers];
    return meta?.displayName ?? key;
  } catch {
    // raw IDs without a `/` (Bedrock model IDs) — never reach this function
    // in practice because the BYOK fallback skips Bedrock, but defensively
    // return the slug itself rather than throw if it ever does.
    return slug;
  }
}

function formatModelLabel(params: {
  model: string;
  fallbackFrom?: string | undefined;
  clamped?: { from: string; reason: "card" | "noRouterPath" | "oss" | "trial" } | undefined;
  unselectedProxyDefault?: boolean | undefined;
  oss?: boolean | undefined;
}): string {
  const alias =
    resolveDisplayAlias(params.model) ??
    // reverse-lookup: when the caller passes an effective model (proxy or
    // resolved target like "openrouter/anthropic/claude-opus-4.7") instead of
    // a stored alias slug, find the alias whose resolve target matches so we
    // still render a friendly display name.
    modelAliases.find((a) => a.resolve === params.model || a.openRouterResolve === params.model);
  const displayName = alias?.displayName ?? params.model;
  // OSS runs have their model costs covered by the program — surface that
  // (and link to the application) instead of the BYOK `(free)` note. an OSS
  // run that overrode a configured pick must say so here: this branch returns
  // before the generic clamp rendering below, so without this the maintainer
  // sees a model they never chose with no indication their pick was ignored.
  if (params.oss) {
    const ossBase = `\`${displayName}\` (free via [Pullfrog for OSS](https://pullfrog.com/for-oss))`;
    if (params.clamped?.reason !== "oss") return ossBase;
    const configured = isAutoTier(params.clamped.from)
      ? "the intelligent tier"
      : `\`${resolveDisplayAlias(params.clamped.from)?.displayName ?? params.clamped.from}\``;
    // the clamp only fires for an OFF-allowlist pick now, so switching to a
    // funded model is the cheap remedy and has to be named first — naming only
    // BYOK is what left maintainers thinking the console offered them nothing.
    return `${ossBase} (${configured} not used — pick one of the [funded models](https://docs.pullfrog.com/models#pullfrog-for-oss) or add a [provider key](https://docs.pullfrog.com/keys) to run your own)`;
  }
  const base = alias?.isFree ? `\`${displayName}\` (free)` : `\`${displayName}\``;
  if (params.fallbackFrom) {
    // "not configured" would be false here: the fallback's only producer is the
    // rejected-credential path, where the user DID configure a credential and
    // the provider turned it down.
    return `${base} (credentials for ${providerDisplayName(params.fallbackFrom)} were rejected by the provider)`;
  }
  if (params.clamped?.reason === "trial") {
    // short form only: the IMPORTANT call-out above the footer already explains
    // what the trial is and how to leave it. repeating it here would say the
    // same thing twice in one comment.
    return `${base} (model usage covered by Pullfrog)`;
  }
  if (params.clamped) {
    // name the tier (not its backing model) when the user picked a tier, so the
    // public copy reads right and doesn't couple to the tier's current target.
    const target = isAutoTier(params.clamped.from)
      ? "the intelligent tier"
      : `\`${resolveDisplayAlias(params.clamped.from)?.displayName ?? params.clamped.from}\``;
    return params.clamped.reason === "card"
      ? `${base} (${target} needs a [card on file](https://docs.pullfrog.com/models))`
      : `${base} (${target} needs a [provider key](https://docs.pullfrog.com/models) — no Router support yet)`;
  }
  if (params.unselectedProxyDefault) {
    return `${base} (default — [pick a model](https://docs.pullfrog.com/models) for stronger reviews)`;
  }
  return base;
}

/**
 * Bottom-of-comment disclosure for a run served by the free trial subsidy.
 *
 * Deliberately NOT a footer part: the `<sup>` line is where every other model
 * substitution is disclosed, and a trial review is a different claim — the
 * reader is being asked to discount findings about their own code, which a
 * subscript pipe-separated fragment cannot carry.
 *
 * Emitted AFTER `KATAK_DIVIDER` so `stripExistingFooter` removes it on every
 * edit. The progress comment is rewritten many times per run; anything placed
 * before the marker would survive each strip and accumulate.
 *
 * The rule is a top-level `---`, not `> ---` — inside the blockquote it would
 * render as a line across the middle of the alert instead of a separator above it.
 *
 * The copy names the RUN rather than a review, because one footer builder feeds
 * four surfaces — a review, a plan or issue comment, a created PR body, and a
 * terminal failure comment — and only the first of those is a review at all.
 */
function buildTrialDisclosure(owner: string | undefined): string {
  // a literal rather than `getApiUrl()`: this module is re-exported through
  // `action/internal/index.ts` into CLIENT components, and `apiUrl.ts` reaches
  // `@actions/core` through `cli.ts` — importing it here pulls node builtins
  // into the browser bundle and fails the Turbopack build. every other link in
  // this footer is already an absolute pullfrog.com URL for the same reason.
  const consoleUrl = owner
    ? `https://pullfrog.com/console/${owner}`
    : "https://pullfrog.com/console";
  return [
    "---",
    "",
    "> [!IMPORTANT]",
    "> **Pullfrog covered this run's model usage.** `DeepSeek Flash` is fast and cheap — expect lighter " +
      "work than a frontier model. This model allowance is temporary and separate from your Pullfrog plan. " +
      `[Connect a model-provider subscription or API key →](${consoleUrl})`,
  ].join("\n");
}

/**
 * build a pullfrog footer with configurable parts
 * always includes: frog logo at start and X link at end
 * order: action links (customParts) > workflow run > model > attribution > reference links
 */
export function buildPullfrogFooter(params: BuildPullfrogFooterParams): string {
  const parts: string[] = [];

  if (params.customParts) {
    parts.push(...params.customParts);
  }

  if (params.workflowRunUrl) {
    parts.push(`[View workflow run](${params.workflowRunUrl})`);
  } else if (params.workflowRun) {
    const baseUrl = `https://github.com/${params.workflowRun.owner}/${params.workflowRun.repo}/actions/runs/${params.workflowRun.runId}`;
    const url = params.workflowRun.jobId ? `${baseUrl}/job/${params.workflowRun.jobId}` : baseUrl;
    parts.push(`[View workflow run](${url})`);
  }

  if (params.triggeredBy) {
    parts.push("via katakpull");
  }

  if (params.model) {
    parts.push(
      `Using ${formatModelLabel({
        model: params.model,
        fallbackFrom: params.fallbackFrom,
        clamped: params.clamped,
        unselectedProxyDefault: params.unselectedProxyDefault,
        oss: params.oss,
      })}`
    );
  }

  const allParts = [...parts];

  const disclosure =
    params.clamped?.reason === "trial" ? `${buildTrialDisclosure(params.owner)}\n\n` : "";

  return `\n\n${KATAK_DIVIDER}\n${disclosure}<sup>${allParts.join(" ｜ ")}</sup>`;
}

/**
 * strip any existing pullfrog footer from a comment body
 */
export function stripExistingFooter(body: string): string {
  const dividerIndex = body.indexOf(KATAK_DIVIDER);
  if (dividerIndex === -1) {
    return body;
  }
  return body.substring(0, dividerIndex).trimEnd();
}
