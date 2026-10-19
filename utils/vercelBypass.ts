/**
 * the Vercel protection-bypass secret for a request to `url`, if it should carry one. only
 * Pullfrog preview deployments sit behind deployment protection, and the env var is Vercel's
 * own name, so a workflow may hold a different project's secret: it never goes anywhere else.
 */
export function vercelBypassSecretFor(url: URL) {
  if (!url.hostname.endsWith("-pullfrog.vercel.app")) return undefined;
  return process.env.VERCEL_AUTOMATION_BYPASS_SECRET || undefined;
}
