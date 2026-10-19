import { isPullfrog } from "./isPullfrog.ts";

/**
 * lightweight paginated query for the approval gate: we only need each thread's
 * resolved state and its ROOT author (oldest comment, hence `first: 1`) to count
 * outstanding Pullfrog findings. distinct from REVIEW_THREADS_QUERY, which pages
 * the same connection but carries full comment bodies — the invariant must hold
 * on PRs with >100 threads, since a silent first-100 cap would let a finding
 * beyond #100 slip an approval through.
 */
const OUTSTANDING_THREADS_QUERY = `
query ($owner: String!, $name: String!, $prNumber: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 1) { nodes { author { login } } }
        }
      }
    }
  }
}
`;

type OutstandingThreadsResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes:
          | ({
              isResolved: boolean;
              comments: { nodes: ({ author: { login: string } | null } | null)[] | null } | null;
            } | null)[]
          | null;
      } | null;
    } | null;
  } | null;
};

/** the slice of a run or webhook context the query needs — shared by the action and the server. */
export type OutstandingThreadsCtx = {
  octokit: { graphql: <T>(query: string, variables: Record<string, unknown>) => Promise<T> };
  repo: { owner: string; name: string };
};

/**
 * count unresolved review threads on a PR whose root comment was authored by
 * Pullfrog's bot. this is the full set of open Pullfrog findings on the PR —
 * the basis for both the never-approve-with-outstanding-issues invariant (the
 * approval gate in create_pull_request_review) and the `pullfrog-approval`
 * status verdict. it is a function of all open findings, NOT just the latest
 * commit's delta.
 *
 * outdated-but-unresolved threads still count — GitHub marks a thread
 * `[OUTDATED]` when the anchor line moved (reformat, rename, force-push), which
 * is not the same as the concern being addressed. human-reviewer threads are
 * excluded: they belong to those reviewers to resolve. walks every page so a
 * long-lived PR with >100 threads can't hide an outstanding finding.
 */
export async function countOutstandingPullfrogThreads(
  ctx: OutstandingThreadsCtx,
  pullNumber: number
): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  // bound the walk so a misbehaving cursor can't loop forever; 50 pages = 5000
  // threads, orders of magnitude beyond any real PR.
  for (let page = 0; page < 50; page += 1) {
    const response: OutstandingThreadsResponse = await ctx.octokit.graphql(
      OUTSTANDING_THREADS_QUERY,
      { owner: ctx.repo.owner, name: ctx.repo.name, prNumber: pullNumber, cursor }
    );
    const conn = response.repository?.pullRequest?.reviewThreads;
    for (const thread of conn?.nodes ?? []) {
      if (!thread || thread.isResolved) continue;
      const root = thread.comments?.nodes?.find((c) => c != null);
      if (root && isPullfrog(root.author?.login)) count += 1;
    }
    if (!conn?.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return count;
}
