/* Step-by-step jobs a connected agent does with the SaaSFunnels MCP tools
   (LEA-2263). Served as MCP prompts and written by `agent install` as skill
   or rules files, so every client follows the same steps. */

export type SaaSFunnelsPlaybook = {
  arguments: Array<{ description: string; name: string; required: boolean }>;
  description: string;
  name: string;
  render: (args: Record<string, string | undefined>) => string;
  title: string;
};

const rules = `Rules:
- You edit drafts only. Never try to publish or delete; hand the merchant the Studio link (studio_url) to publish.
- Read the draft revision with get_funnel_state before apply_funnel_changes and send it as expected_draft_revision. On a revision conflict, read again and retry.
- Get each edit command's shape from get_funnel_command_schema. Send at most 16 changes per batch; the whole batch is refused if any change is.
- Set agent_name to your name (for example "Claude Code") so the merchant sees who changed what in Studio.
- Never put secrets, source code or customer data into a tool call.`;

const launchSteps = (goal: string, template?: string) => `Goal: ${goal}

1. Call list_funnel_templates.${template ? ` Use the ${template} template if it's available.` : " Pick the template that matches the goal."} If it needs a Feature, choose one from the returned features list (one with a usage limit when needs_feature_with_limit is true).
2. Call create_funnel_draft with a new random UUID v4 as request_key, the template_key and any feature_key. Keep the funnel_id and studio_url.
3. Call get_install_status. If the snippet hasn't been seen, install the SaaSFunnels Web SDK in this app (the snippet is on the Install code page at settings_url). If the site isn't allowed yet, call propose_allowed_site and give the merchant the approve_url.
4. Call get_launch_checklist. For the entry, call propose_funnel_entry_installation, add the binding in this app's code exactly as planned, then apply_funnel_entry and submit_funnel_entry_evidence.
5. If the entry uses an event this app now sends, call confirm_event_mapping so it's read correctly.
6. Call run_funnel_binding_test and trigger the entry in the app with the returned test token. Call get_launch_checklist again until the entry is detected in Test.
7. Call get_funnel_outline and validate_funnel_draft. Fix anything that blocks publishing with apply_funnel_changes.
8. Finish by telling the merchant what you set up, what's left on the checklist, and the studio_url to review and publish.

${rules}`;

export const saasFunnelsPlaybooks: SaaSFunnelsPlaybook[] = [
  {
    arguments: [
      { description: "What the Funnel should do, in the merchant's words.", name: "goal", required: false },
      { description: "A template_key from list_funnel_templates.", name: "template", required: false },
    ],
    description: "Create a Funnel from a template, wire it into this app and get it to Test.",
    name: "launch_funnel",
    render: (args) =>
      launchSteps(args.goal?.trim() || "Launch a Funnel in this app and get it to Test.", args.template?.trim() || undefined),
    title: "Launch a Funnel",
  },
  {
    arguments: [],
    description: "Add a cancellation save Funnel on this app's Cancel button.",
    name: "add_cancellation_flow",
    render: () =>
      launchSteps(
        "Show a cancellation save Funnel when a customer clicks Cancel subscription in this app. If the customer still cancels, the app's own cancellation continues.",
        "cancellation_save",
      ),
    title: "Add a cancellation save flow",
  },
  {
    arguments: [],
    description: "Recover failed payments with a Funnel that asks the customer to update their card.",
    name: "recover_failed_payments",
    render: () =>
      launchSteps(
        "Show a Funnel to customers whose payment failed so they can update their card and keep their plan.",
        "failed_payment_recovery",
      ),
    title: "Recover failed payments",
  },
  {
    arguments: [
      { description: "The Funnel's ID from list_funnels.", name: "funnel_id", required: true },
      { description: "What to change, in the merchant's words.", name: "change", required: true },
    ],
    description: "Edit a Funnel draft and check the result.",
    name: "edit_funnel",
    render: (args) => `Goal: ${args.change?.trim() || "Improve this Funnel."}

1. Call get_funnel_state and get_funnel_outline for funnel ${args.funnel_id ?? "<funnel_id>"} to see the draft and what customers see.
2. If the change involves an Offer, call get_offer_catalog and use its plans, prices and plan_map. New discounts are prepared in the draft and created by the merchant in Studio.
3. Call get_funnel_command_schema for each command type you need, then apply_funnel_changes with every edit in one batch.
4. Call get_funnel_outline and validate_funnel_draft to check the result; fix anything that blocks publishing.
5. Tell the merchant what changed and give them the studio_url to review, undo or publish.

${rules}`,
    title: "Edit a Funnel",
  },
  {
    arguments: [
      { description: "The Funnel's ID from list_funnels.", name: "funnel_id", required: true },
    ],
    description: "Read a live Funnel's results and set up an A/B test on its draft.",
    name: "improve_funnel",
    render: (args) => `Goal: find where funnel ${args.funnel_id ?? "<funnel_id>"} loses people and test a fix.

1. Call get_funnel_results (window 30d). Find the step with the highest drop_off and look at the answers and actions.
2. Call get_funnel_outline to read that step as customers see it.
3. Propose one change to the merchant and why. When they agree, set up an A/B test on the draft with apply_funnel_changes using set_experiment (get its shape from get_funnel_command_schema).
4. Call validate_funnel_draft, then give the merchant the studio_url to review and publish the test.

${rules}`,
    title: "Improve a Funnel",
  },
];

/** One skill or rules file for a coding agent, with every playbook in it. */
export function funnelPlaybookFile(target: "claude-code" | "codex" | "cursor" | "markdown") {
  const body = saasFunnelsPlaybooks
    .map((playbook) => `## ${playbook.title}\n\n${playbook.description}\n\n${playbook.render({})}`)
    .join("\n\n");
  const intro =
    "Use the SaaSFunnels MCP tools to build, wire up and test Funnels in this app. Connect the SaaSFunnels MCP server first (hosted at https://app.saasfunnels.com/mcp, or `npx saasfunnels mcp serve --enable-funnel-writes --enable-funnel-tests` with SAASFUNNELS_API_KEY).";
  if (target === "claude-code")
    return {
      contents: `---\nname: saasfunnels-funnels\ndescription: Build, wire up and test SaaSFunnels Funnels in this app with the SaaSFunnels MCP tools. Use when asked to add a Funnel, cancellation flow, upgrade prompt, failed-payment recovery, or to change or improve one.\n---\n\n# SaaSFunnels Funnels\n\n${intro}\n\n${body}\n`,
      path: ".claude/skills/saasfunnels-funnels/SKILL.md",
    };
  if (target === "codex")
    return {
      contents: `---\nname: saasfunnels-funnels\ndescription: Build, wire up and test SaaSFunnels Funnels in this app with the SaaSFunnels MCP tools.\n---\n\n# SaaSFunnels Funnels\n\n${intro}\n\n${body}\n`,
      path: ".agents/skills/saasfunnels-funnels/SKILL.md",
    };
  if (target === "cursor")
    return {
      contents: `---\ndescription: Build, wire up and test SaaSFunnels Funnels with the SaaSFunnels MCP tools.\nalwaysApply: false\n---\n\n# SaaSFunnels Funnels\n\n${intro}\n\n${body}\n`,
      path: ".cursor/rules/saasfunnels-funnels.mdc",
    };
  return {
    contents: `# SaaSFunnels Funnels\n\n${intro}\n\n${body}\n`,
    path: "SAASFUNNELS-FUNNELS.md",
  };
}
