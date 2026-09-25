import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { agents } from "../agents/index.ts";
import type { WorkflowPermissions } from "../external.ts";
import { AZURE_PROVIDER, OPENAI_COMPATIBLE_PROVIDER, providers } from "../models.ts";

// upstream pulled a second workflow from the parent monorepo (pullfrog/app)
// and asserted parity with this one. katakreview is a standalone repo — there
// is no parent workflow — so only the action-repo assertions remain.

const __dirname = dirname(fileURLToPath(import.meta.url));
const actionDir = join(__dirname, "..");

type WorkflowJob = {
  "runs-on": string;
  "timeout-minutes"?: number;
  permissions?: WorkflowPermissions;
  strategy?: { "fail-fast": boolean; matrix: Record<string, unknown> };
  env?: Record<string, string>;
  steps?: unknown[];
};

type Workflow = {
  name: string;
  jobs: Record<string, WorkflowJob>;
};

const actionWorkflow = parse(
  readFileSync(join(actionDir, ".github/workflows/test.katak.yml"), "utf-8")
) as Workflow;

function getTestNamesFromDir(dir: string): string[] {
  const dirPath = join(__dirname, dir);
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".ts"));
  const names: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(dirPath, file), "utf-8");
    const match = content.match(/^\s+name:\s*"([^"]+)"/m);
    if (match) {
      names.push(match[1]);
    }
  }

  return names.sort();
}

function getEnvVarNames(job: WorkflowJob): string[] {
  return Object.keys(job.env ?? {}).sort();
}

const expectedAgents = Object.keys(agents).sort();
const crossagentTests = getTestNamesFromDir("crossagent");
const agnosticTests = getTestNamesFromDir("agnostic");
const adhocTests = getTestNamesFromDir("adhoc");

// all provider API key names + managed credentials (e.g. Codex auth blob)
// + GITHUB_TOKEN + model overrides. openai-compatible and azure point at a
// backend only the customer has, so we hold no credential to wire into the CI
// env blocks — exclude them. bedrock/vertex are routing too but CI-wired with
// real test creds.
const UNTESTABLE_ROUTING: ReadonlySet<string> = new Set([
  OPENAI_COMPATIBLE_PROVIDER,
  AZURE_PROVIDER,
]);
const isUncatalogedByokProvider = (p: (typeof providers)[keyof typeof providers]) =>
  Object.values(p.models).every((m) => m.routing && UNTESTABLE_ROUTING.has(m.routing));
const expectedAgentEnvVars = [
  "GITHUB_TOKEN",
  ...new Set(
    Object.values(providers)
      .filter((p) => !isUncatalogedByokProvider(p))
      .flatMap((p) => [...p.envVars, ...(p.managedCredentials ?? [])])
  ),
  "KATAK_MODEL",
].sort();

const expectedAgnosticEnvVars = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"].sort();

describe("ci workflow consistency", () => {
  it("no duplicate test names across directories", () => {
    const allNames = [...crossagentTests, ...agnosticTests, ...adhocTests];
    const duplicates = allNames.filter((name, idx) => allNames.indexOf(name) !== idx);
    expect(duplicates).toEqual([]);
  });

  describe("cross-agent tests", () => {
    const actionJob = actionWorkflow.jobs.agents;

    it("action agent matrix matches agents map", () => {
      expect((actionJob.strategy?.matrix.agent as string[])?.slice().sort()).toEqual(
        expectedAgents
      );
    });

    it("action test matrix matches crossagent/ directory", () => {
      expect((actionJob.strategy?.matrix.test as string[])?.slice().sort()).toEqual(
        crossagentTests
      );
    });

    it("env vars cover all provider API keys", () => {
      expect(getEnvVarNames(actionJob)).toEqual(expectedAgentEnvVars);
    });

    it("fail-fast is enabled", () => {
      expect(actionJob.strategy?.["fail-fast"]).toBe(true);
    });
  });

  describe("agnostic tests", () => {
    const actionJob = actionWorkflow.jobs.agnostic;

    it("action test matrix matches agnostic/ directory", () => {
      expect((actionJob.strategy?.matrix.test as string[])?.slice().sort()).toEqual(agnosticTests);
    });

    it("env vars are correct for agnostic tests", () => {
      expect(getEnvVarNames(actionJob)).toEqual(expectedAgnosticEnvVars);
    });

    it("fail-fast is enabled", () => {
      expect(actionJob.strategy?.["fail-fast"]).toBe(true);
    });
  });
});
