import * as p from "@clack/prompts";
import arg from "arg";
import { z } from "zod";
import {
  type Subscription,
  type SubscriptionName,
  subscriptionListSchema,
  subscriptionStatusText,
} from "../utils/subscriptionCredentials.ts";
import {
  type CliTarget,
  configurationApi,
  confirmChange,
  resolveTarget,
  scopeArgs,
} from "./_configuration.ts";
import { handleCancel } from "./_shared.ts";

/** what the user asked for before signing in: `replace` one of `current`, or add to them. */
export interface SubscriptionChoice {
  current: Subscription[];
  replace: Subscription | undefined;
}

function replaceLabel(row: Subscription) {
  const status = subscriptionStatusText(row);
  return status ? `Replace ${row.label} (${status})` : `Replace ${row.label}`;
}

export async function chooseSubscription(input: {
  target: CliTarget;
  token: string;
  name: SubscriptionName;
}): Promise<SubscriptionChoice | null> {
  const result = subscriptionListSchema.parse(
    await configurationApi({ ...input, path: "subscriptions" })
  );
  const current = result.subscriptions.filter((row) => row.name === input.name && !row.inherited);
  if (!current.length) return { current, replace: undefined };
  const chosen = await p.select({
    message: "Add or replace a subscription?",
    options: [
      { value: "add", label: "Add another", hint: "keep existing subscriptions as fallbacks" },
      ...current.map((row) => ({ value: row.id, label: replaceLabel(row) })),
      { value: "cancel", label: "Cancel" },
    ],
  });
  handleCancel(chosen);
  if (typeof chosen !== "string" || chosen === "cancel") return null;
  return { current, replace: current.find((row) => row.id === chosen) };
}

export async function saveSubscription(input: {
  target: CliTarget;
  token: string;
  name: SubscriptionName;
  value: string;
  replaceId: string | undefined;
}) {
  return z.object({ id: z.string(), label: z.string(), reconnected: z.boolean() }).parse(
    await configurationApi({
      target: input.target,
      token: input.token,
      path: "subscriptions",
      method: "POST",
      body: { name: input.name, value: input.value, replaceId: input.replaceId },
    })
  );
}

export async function manageSubscriptions(input: { command: string; args: string[] }) {
  const args = arg({ ...scopeArgs, "--from": String, "--yes": Boolean }, { argv: input.args });
  if (args["--help"]) {
    console.log(
      "usage: pullfrog auth list|remove|share|unshare [ID] --org OWNER | --repo OWNER/REPO [--from PERSONAL_OWNER] [--yes]"
    );
    return;
  }
  const target = resolveTarget({ org: args["--org"], repo: args["--repo"] });
  if (input.command === "list") {
    const result = subscriptionListSchema.parse(
      await configurationApi({ target, path: "subscriptions" })
    );
    console.log("BINDING ID\tCREDENTIAL ID\tPROVIDER\tACCOUNT\tSTATUS");
    for (const item of result.subscriptions)
      console.log(
        `${item.id}\t${item.credentialId}\t${item.name}\t${item.label}${item.inherited ? " (inherited)" : ""}\t${subscriptionStatusText(item) ?? "-"}`
      );
    return;
  }
  const id = args._[0];
  if (!id || args._.length !== 1) throw new Error("specify exactly one ID from pullfrog auth list");
  if (input.command === "remove") {
    await confirmChange({
      message: `Remove subscription ${id} from ${target.owner}${target.repo ? `/${target.repo}` : " and inheriting repositories (removing a personal connection also revokes its shares)"}?`,
      yes: args["--yes"] ?? false,
    });
    await configurationApi({ target, path: "subscriptions", method: "DELETE", body: { id } });
    return;
  }
  const from = args["--from"];
  if (!from) throw new Error("--from PERSONAL_OWNER is required");
  await confirmChange({
    message:
      input.command === "share"
        ? `Allow every authorized run on ${target.owner}${target.repo ? `/${target.repo}` : " and its repositories"} to use personal subscription ${id}?`
        : `Revoke personal subscription ${id} from this target?`,
    yes: args["--yes"] ?? false,
  });
  await configurationApi({
    target,
    path: "subscriptions/share",
    method: input.command === "share" ? "POST" : "DELETE",
    body: { from, credentialId: id, ...target, confirmed: true },
  });
}
