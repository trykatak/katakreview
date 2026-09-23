import { getApiUrl } from "./apiUrl.ts";
import { log } from "./cli.ts";
import { getLastRunToken } from "./payload.ts";

/**
 * SELFHOST: report the run's aggregated token usage + cost to the dispatcher
 * (POST {API_URL}/api/runs/usage), authenticated by the run token the
 * dispatcher embedded in the dispatch payload. Fire-and-forget: the caller
 * wraps this in void/catch so telemetry can never fail a run.
 */
export async function reportUsage(toolState: {
  usageEntries: Array<{
    agent: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    costUsd?: number | undefined;
  }>;
  model?: string | undefined;
}): Promise<void> {
  const runToken = getLastRunToken();
  const repo = process.env.GITHUB_REPOSITORY;
  if (!runToken || !repo) return; // not a dispatched run (manual prompt etc.)

  const total = toolState.usageEntries.reduce(
    (acc, e) => ({
      input: acc.input + (e.inputTokens || 0),
      output: acc.output + (e.outputTokens || 0),
      cacheRead: acc.cacheRead + (e.cacheReadTokens || 0),
      cacheWrite: acc.cacheWrite + (e.cacheWriteTokens || 0),
      costUsd: acc.costUsd + (e.costUsd || 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
  );
  if (total.input === 0 && total.output === 0) return;

  const body = JSON.stringify({
    runToken,
    repo,
    model: toolState.model ?? null,
    usage: total,
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${getApiUrl()}/api/runs/usage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) log.debug(`usage report rejected: ${resp.status}`);
    else log.info("» usage report sent");
  } catch (err) {
    log.debug(`usage report failed: ${String(err)}`);
  }
}
