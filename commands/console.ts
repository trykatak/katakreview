import { spawnSync } from "node:child_process";
import arg from "arg";
import { resolveTarget, scopeArgs } from "./_configuration.ts";
import { KATAK_API_URL } from "./_shared.ts";

export async function runCli(input: { args: string[]; prog: string; showHelp?: boolean }) {
  const args = arg({ ...scopeArgs, "--no-browser": Boolean }, { argv: input.args });
  if (input.showHelp || args["--help"]) {
    console.log(
      `usage: ${input.prog} console [--org OWNER | --repo OWNER/REPO] [--no-browser]\n\nopen the selected console; defaults to the current GitHub repository.\nwithout a terminal, only print its URL.`
    );
    return;
  }
  if (args._.length) throw new Error("console accepts --org OWNER or --repo OWNER/REPO");
  const target = resolveTarget({ org: args["--org"], repo: args["--repo"] });
  const url = new URL(
    `/console/${encodeURIComponent(target.owner)}${target.repo ? `/${encodeURIComponent(target.repo)}` : ""}`,
    KATAK_API_URL
  );
  console.log(url.href);
  if (args["--no-browser"] || !process.stdout.isTTY) return;
  const result =
    process.platform === "win32"
      ? spawnSync("rundll32.exe", ["url.dll,FileProtocolHandler", url.href], { stdio: "ignore" })
      : spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [url.href], {
          stdio: "ignore",
        });
  if (result.error || result.status !== 0)
    console.error("could not open a browser; open the URL above");
}
