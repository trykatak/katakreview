#!/usr/bin/env node

import "./utils/legacyEnv.ts";
import { runPullfrogCli } from "./runCli.ts";

runPullfrogCli({
  cliArgs: ["gha"],
});
