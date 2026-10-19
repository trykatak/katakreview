import { getModelEnvVars, getProviderGatewayUrl, stripProviderPrefix } from "../models.ts";
import { preflightClaudeSubscription } from "./claudeSubscription.ts";
import { log } from "./cli.ts";
import { verifyCredential } from "./credentialCheck.ts";

/**
 * `ok` covers "the credential works", "we couldn't tell", and "something else
 * on this model still works" — the run proceeds as it did before this check
 * existed. `dead` is only reached when every credential the configured model
 * could use has been explicitly rejected by its own provider. A run never moves
 * to a different model: the pool of credentials for THIS provider is where a
 * rejected one is routed around (see wiki/subscription-credentials.md).
 */
export type CredentialOutcome =
  | { kind: "ok" }
  | { kind: "dead"; credential: string; reason: string | undefined };

/**
 * How badly a credential failed. `dead` is the credential itself (401) and is
 * the only verdict that earns the "re-authenticate / re-issue" copy. `unusable`
 * is 403 (not entitled) or 429 (at its limit) — the credential is real, so this
 * run routes around it if it can, but the remedy is the provider's own (wait
 * for the reset, ask an admin) and `formatApiKeyErrorSummary` already renders
 * both from the agent's own error. Collapsing the two would tell a rate-limited
 * subscriber to re-issue a perfectly healthy credential.
 */
type Failure = { severity: "dead" | "unusable"; reason: string | undefined };

function hasEnvVar(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

/**
 * `getModelEnvVars` THROWS on a slugless model, and bedrock / vertex resolve to
 * a bare backend model id (`gemini-2.5-flash`, `us.anthropic.claude-opus-4-6-v1`)
 * rather than a `provider/model` specifier. Their credentials are multi-var and
 * have dedicated setup validators, and neither is in the probe table, so there
 * is nothing here for them anyway. Same guard `buildMissingApiKeyError` already
 * applies. (`openai-compatible` is NOT in this set — `resolveSlug` keeps its
 * `openai-compatible/` prefix, so it takes the normal path.)
 */
function envVarsFor(model: string): string[] {
  return model.includes("/") ? getModelEnvVars(model) : [];
}

/**
 * "Can this credential serve THIS run?" — the subscription token is probed
 * against the run's own model, since Anthropic's limits are per-model and a
 * cheaper stand-in would pass while the run still died.
 */
async function checkOne(params: { envVar: string; model: string }): Promise<Failure | null> {
  const value = process.env[params.envVar];
  if (!value) return null;

  // a gateway re-points where this credential is SENT, so the vendor's own host
  // cannot answer whether it is valid. keyed on the model's provider, so every
  // credential it accepts is covered at once. see wiki/credential-rejection.md.
  if (getProviderGatewayUrl(params.model)) return null;

  if (params.envVar === "CLAUDE_CODE_OAUTH_TOKEN") {
    const preflight = await preflightClaudeSubscription({
      token: value,
      model: stripProviderPrefix(params.model),
    });
    if (preflight.usable) return null;
    return { severity: preflight.status === 401 ? "dead" : "unusable", reason: preflight.reason };
  }

  // the /v1/models-style probes carry no message worth repeating — the copy
  // already says the provider refused it, so there is nothing to quote.
  const verdict = await verifyCredential({ envVar: params.envVar, value });
  return verdict === "dead" ? { severity: "dead", reason: undefined } : null;
}

/**
 * Ask the providers whether the credentials behind the configured model still
 * work, BEFORE the agent spawns — so a rejected one becomes either a run on
 * another credential for the same model or an accurate error, instead of the
 * agent 401ing three seconds in against a "rotate your GitHub Actions secret"
 * CTA naming a place the user never put a key.
 *
 * Failed credentials are deleted from `process.env` only when this run can
 * still proceed without them. Nothing downstream infers anything from that
 * deletion — `claude.ts` runs its own preflight regardless, because this check
 * cannot promise it probed any particular token (see its comment for the three
 * paths that reach it unprobed).
 *
 * Only providers in the `credentialCheck` probe table can be found dead; every
 * other credential is left exactly as it was.
 */
export async function checkConfiguredCredentials(params: {
  model: string | undefined;
}): Promise<CredentialOutcome> {
  if (!params.model) return { kind: "ok" };

  const present = envVarsFor(params.model).filter(hasEnvVar);
  // no credential at all is the missing-key path, which already has its own
  // error copy and its own CTA — this check has nothing to add to it.
  if (present.length === 0) return { kind: "ok" };

  const model = params.model;
  const checked = await Promise.all(
    present.map(async (envVar) => ({ envVar, failure: await checkOne({ envVar, model }) }))
  );
  const failed = checked.flatMap((entry) =>
    entry.failure ? [{ envVar: entry.envVar, failure: entry.failure }] : []
  );
  if (failed.length === 0) return { kind: "ok" };

  const drop = (entry: { envVar: string; failure: Failure }) => {
    const detail = entry.failure.reason;
    log.info(`» ${entry.envVar} rejected by its provider${detail ? ` (${detail})` : ""}`);
    delete process.env[entry.envVar];
  };

  // another credential still serves this model, so drop the bad ones and let
  // the agent use the good one — the same-provider fallback `claude.ts` used to
  // own (an exhausted subscription giving way to an API key).
  if (failed.length < checked.length) {
    failed.forEach(drop);
    return { kind: "ok" };
  }

  // every credential for this model failed, but not all of them are dead
  // CREDENTIALS — a 403 or 429 is the provider's own condition with its own
  // remedy, and the agent's error already renders it correctly. leave the env
  // untouched so that message survives rather than becoming "no API key found".
  if (failed.some((entry) => entry.failure.severity !== "dead")) return { kind: "ok" };

  failed.forEach(drop);
  const first = failed[0];
  if (!first) return { kind: "ok" };
  return { kind: "dead", credential: first.envVar, reason: first.failure.reason };
}
