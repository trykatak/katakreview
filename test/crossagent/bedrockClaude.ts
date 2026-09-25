import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

const fixture = defineFixture(
  {
    prompt: `Call set_output with "BEDROCK CLAUDE SMOKE PASSED".`,
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = result.structuredOutput;
  const setOutputCalled = output !== null;
  const correctValue = setOutputCalled && /BEDROCK CLAUDE SMOKE PASSED/i.test(output);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "correct_value", passed: correctValue },
  ];
}

export const test: TestRunnerOptions = {
  name: "bedrock-claude",
  agents: ["claude"],
  fixture,
  validator,
  env: {
    KATAK_DISABLE_SECURITY_INSTRUCTIONS: "1",
    KATAK_MODEL: "bedrock/byok",
    BEDROCK_MODEL_ID: "us.anthropic.claude-sonnet-4-6",
    AWS_REGION: "us-east-1",
  },
  // disabled: our AWS account rejects every Bedrock invoke with
  // `400 Operation not allowed`, which is an account-side entitlement problem,
  // not a Pullfrog regression. delete this line once the account is fixed.
  skipIf: () => "bedrock disabled — AWS account not entitled for InvokeModel",
};
