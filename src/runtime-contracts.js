var DIRECT_API_AGENT_HANDOFF_VERSION = "2026-06-28.1";
var ingestKeyPlaceholder = "<SAASFUNNELS_INGEST_KEY>";
var skillName = "saasfunnels-event-discovery";
function directApiSamplePayload() {
  return {
    account_id: "acct_123",
    event_id: "evt_direct_001",
    event_kind: "friction_event",
    event_name: "usage_limit_hit",
    properties: {
      account_created_at: "2026-06-01T12:00:00.000Z",
      active_user_count: 6,
      is_in_trial: true,
      limit_name: "monthly_events",
      plan: "starter",
      seat_count: 10,
      trial_ends_at: "2026-06-28T12:00:00.000Z",
      usage_ratio: 0.93,
      user_count: 7
    },
    semantic_type: "limit_friction",
    sentiment: "negative",
    sentiment_confidence: 0.9,
    sentiment_score: -0.8,
    sentiment_source: "explicit",
    timestamp: "2026-06-20T15:00:00.000Z",
    user_id: "user_456",
    value: 1
  };
}
function directApiJsonExample() {
  return JSON.stringify(directApiSamplePayload(), null, 2);
}
function directApiCurlExample(endpoint) {
  return `curl -X POST ${endpoint} \\
  -H "Authorization: Bearer ${ingestKeyPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -d '${directApiJsonExample()}'`;
}
function eventPlanMarkdown(eventPlan) {
  if (!eventPlan?.eventFamilies.length) return "";
  const motions = eventPlan.selectedUseCases.length ? eventPlan.selectedUseCases.join(", ") : "not selected";
  const families = eventPlan.eventFamilies.slice(0, 8).map(
    (family) => `- ${family.label} (\`${family.semanticType}\`, ${family.required ? "required" : "helpful"}): ${family.exampleEventNames.slice(0, 3).map((name) => `\`${name}\``).join(", ")}`
  ).join("\n");
  return `
## Revenue Motions Selected

- ${motions}
- Preferred source path: ${eventPlan.recommendedSourcePath.label}
- Destination preference: ${eventPlan.destinationPreference ?? "not selected"}

## Event Families To Prioritize

${families}
`;
}
function buildBriefMarkdown(endpoint, eventPlan) {
  return `# Install SaaSFunnels Direct API

You are adding SaaSFunnels Direct API events to this customer application. Treat Direct API as backend/source-of-truth instrumentation for durable product, billing, setup, usage, and lifecycle events. This is different from the Web SDK: Direct API uses a secret server-side ingest key and should not run in browser, mobile, desktop, or public client code.

## Install values

- Endpoint: \`${endpoint}\`
- Auth header: \`Authorization: Bearer ${ingestKeyPlaceholder}\`
- Environment variable: \`SAASFUNNELS_INGEST_API_KEY=${ingestKeyPlaceholder}\`
- Help article: \`https://docs.saasfunnels.ai/integrations-and-sources/direct-api-installation\`

## Direct API-first event discovery

Use SaaSFunnels Event Discovery to inspect the app in one pass and add the first high-signal backend events. The primary goal of this brief is to implement authoritative Direct API events, not browser click tracking.

Discovery workflow:

1. Search for backend/server code paths, API routes, controllers, services, jobs, billing handlers, integrations, webhooks, analytics wrappers, database models, and durable product state changes.
2. Identify the stable account object: account, organization, workspace, company, tenant, team, customer, or project.
3. Build a short candidate list across activation, usage, limit friction, upgrade intent, checkout, downgrade/cancel, team expansion, setup milestones, billing/subscription changes, and support friction.
4. Classify each candidate as:
   - \`direct_api_now\`: durable backend event that should be sent through Direct API now.
   - \`existing_source\`: already covered by Stripe, PostHog, Segment, Direct API, warehouse, or another reliable event source.
   - \`web_sdk_follow_up\`: browser-visible intent or UI friction that is better captured by the Web SDK.
5. Implement the highest-signal \`direct_api_now\` events first.
6. Include a short follow-up list for \`web_sdk_follow_up\` candidates in the final implementation notes.

Choose Direct API for:

- Completed billing or subscription state changes.
- Checkout completed, invoice paid, payment failed, refund, downgrade completed, cancel completed.
- Durable setup milestones such as integration configured, OAuth connected, destination configured, API key created, or first event ingested.
- Metered usage, credits consumed, quota calculations, API calls, background jobs, sync results, and anything billable.
- \`first_*\` milestones that must be race-safe and based on persisted state.

Use the Web SDK instead for browser-only intent before backend state changes, visible prompts, page-level UI friction, and supplemental adoption signals. Do not block this Direct API implementation on browser instrumentation; capture those as \`web_sdk_follow_up\`.

## Event contract

- Every P0/P1 event must include \`account_id\`.
- Include \`user_id\` when a user caused the event.
- Use static lower_snake_case event names and property names.
- Emit authoritative events after durable database, provider, billing, or credential persistence succeeds.
- Use a stable \`event_id\` or deterministic idempotency key for completed state changes.
- Treat \`first_*\` milestones as blocked unless durable state proves first occurrence race-safely.
- Keep delivery non-blocking for customer product flows. A SaaSFunnels failure should not break checkout, onboarding, billing, or core product work.
${eventPlanMarkdown(eventPlan)}

## Minimum viable SaaS account facts

SaaSFunnels should learn a small account profile while events arrive. Send these as bounded \`properties\` on normal account-scoped events, especially signup, login, activation, plan change, team, and usage rollup events. Do not create noisy page-view events just to refresh profile data.

Recommended fields:

| Fact | Preferred field names | Notes |
| --- | --- | --- |
| Customer signup date | \`account_created_at\`, \`signup_at\`, or \`customer_created_at\` | This is the customer's product signup date, not the time SaaSFunnels first saw the account. |
| Login activity | \`user_logged_in\` or \`session_started\` events with \`semantic_type: "login"\` | Include \`user_id\`; Direct API or the Web SDK can derive login counts from these events. |
| Plan and lifecycle | \`plan\`, \`plan_name\`, \`current_plan\`, \`account_status\`, or \`subscription_status\` | Keep values bounded and stable, such as \`starter\`, \`growth\`, \`active\`, \`trialing\`, or \`canceled\`. |
| Trial state | \`is_in_trial\`, \`trial_started_at\`, \`trial_ends_at\` | Use this only when Stripe is not connected or before Stripe is available. Stripe is authoritative for billing and trial state when connected. |
| Team and seats | \`user_count\`, \`active_user_count\`, \`seat_count\`, or \`member_count\` | Send current account-level counts from backend state or a scheduled rollup, not raw user lists. |

Good default implementation:

1. Add account facts to the first durable signup/onboarding event.
2. Emit a login event when a real authenticated sign-in or session start succeeds.
3. Refresh plan, trial, user, and seat counts on lifecycle changes or daily account rollups.
4. Keep Stripe metadata aligned with the same stable \`account_id\` so billing events can override billing and trial facts.

## Implementation plan

1. Store the real ingest key in backend/server environment variables only.
2. Create a small server-side helper for SaaSFunnels delivery that sets the Authorization header, JSON content type, timeout, retries if appropriate, and safe logging.
3. Add explicit calls after durable success points. Do not emit before database commits, provider confirmation, billing confirmation, or credential persistence.
4. Generate deterministic \`event_id\` values for retryable completed events, for example \`checkout_completed:<checkout_id>\` or \`integration_connected:<provider>:<account_id>\`.
5. Send bounded structured properties only.
6. Add tests or a manual smoke path for one account-scoped event.
7. Verify in SaaSFunnels under Settings > Integrations > Direct API > Activity.

## Events to add first

Start with a small allowlist. Prefer completed backend state changes over generic activity.

| Event family | What to look for in server code | Example event names | Useful properties | Direct API guidance |
| --- | --- | --- | --- | --- |
| Activation / first value | Durable onboarding completion, first successful setup, first useful output persisted | \`account_activated\`, \`first_value_completed\`, \`onboarding_completed\` | \`plan\`, \`feature\`, \`value\`, \`step\`, optional sentiment fields | Strong Direct API fit when persisted state proves completion. |
| High-value usage | Completed workflow, export, generation, report, API operation, metered usage, key feature use | \`feature_used\`, \`workflow_completed\`, \`report_exported\`, \`api_credits_used\`, \`generation_completed\`, \`sync_completed\` | \`feature_key\`, \`feature_area\`, \`is_key_feature\`, \`is_premium\`, \`value\`, \`quantity\`, \`usage_ratio\`, \`allowance\` | Prefer Direct API for metered or billable usage and server-confirmed operations. Use properties for feature identity instead of dynamic event names. |
| Limit friction | Server-side quota decision, usage cap, paywall block, overage warning | \`limit_hit\`, \`quota_blocked\`, \`overage_prompt_viewed\` | \`usage_ratio\`, \`allowance\`, \`plan\`, \`feature\`, \`value\`, sentiment fields | Strong Direct API fit when limit calculation happens server-side. |
| Checkout | Checkout started/completed/abandoned, payment page opened, payment flow completed | \`checkout_started\`, \`checkout_completed\`, \`checkout_abandoned\` | \`plan\`, \`target_plan\`, \`value\`, \`currency\`, \`billing_period\` | Stripe/backend should be authoritative for completed payment. Web SDK can supplement earlier starts or abandons. |
| Billing lifecycle | Subscription, invoice, payment, plan, or billing-status state changed | \`subscription_updated\`, \`subscription_upgraded\`, \`invoice_payment_failed\`, \`payment_succeeded\`, \`plan_changed\` | \`plan\`, \`previous_plan\`, \`current_plan\`, \`subscription_status\`, \`billing_signal_type\`, \`value\`, \`currency\` | Prefer Stripe when connected. Use Direct API only when the product backend is the billing source of truth. |
| Downgrade or cancel | Downgrade confirmed, cancellation confirmed, pause subscription completed | \`downgrade_completed\`, \`cancel_completed\`, \`subscription_paused\` | \`plan\`, \`reason_code\`, \`source\`, sentiment fields | Use bounded reason codes only. Do not send free-text cancellation reasons. |
| Team expansion | Invite persisted, seat added, member joined, role assigned | \`team_member_invited\`, \`seat_added\`, \`role_assigned\` | \`quantity\`, \`role\`, \`plan\` | Prefer Direct API for confirmed invite/seat creation. Web SDK can capture pre-submit intent. |
| Integration connected | OAuth success persisted, data source connected, destination enabled | \`integration_connected\`, \`oauth_connected\`, \`destination_configured\` | \`integration\`, \`provider\`, \`step\`, sentiment fields | Emit only after credentials/configuration are persisted. Never send provider tokens or webhook secrets. |
| Product or support friction | Failed job persisted, sync failure recorded, blocked setup state, support-worthy product error | \`sync_failed\`, \`setup_failed\`, \`support_needed\` | \`feature\`, \`error_code\`, \`severity\`, sentiment fields | Use bounded error codes/statuses. Do not send raw logs, stack traces, support messages, or user-entered text. |

Coverage guidance:

- Add 3 to 6 high-signal events first; do not send every backend log or analytics event.
- Prefer events across at least two families if possible, for example activation plus usage, or usage plus limit friction.
- Keep event names stable across sources. If Web SDK, PostHog, Segment, or Stripe later sends the same business event, use the same \`event_name\` and account ID.
- When in doubt, choose durable completion events over generic page views, modal opens, hovers, debug logs, or local UI toggles.

## Payload example

\`\`\`json
${directApiJsonExample()}
\`\`\`

## Request example

\`\`\`bash
${directApiCurlExample(endpoint)}
\`\`\`

## Sentiment

Sentiment is optional and separate from the event family. Use it only when the backend event has a bounded signal about the customer experience or intent. If there is no clear signal, omit sentiment; SaaSFunnels will treat missing sentiment as \`unknown\`.

Accepted fields:

| Field | Allowed values |
| --- | --- |
| \`sentiment\` | \`positive\`, \`neutral\`, \`negative\`, \`unknown\` |
| \`sentiment_score\` | Number from \`-1\` to \`1\`, where negative values indicate friction and positive values indicate healthy intent |
| \`sentiment_confidence\` | Number from \`0\` to \`1\` |
| \`sentiment_source\` | \`explicit\`, \`inferred\`, \`ai\`, \`integration\`, \`unknown\` |

Do not set \`sentiment: "neutral"\` just because sentiment is unavailable. Neutral should mean an explicitly neutral product signal. Do not send free-text feedback, survey responses, chat messages, support transcripts, raw comments, or AI-generated summaries as sentiment context.

## Do not send

- Raw PII, passwords, tokens, cookies, signatures, auth headers, API keys, or session values.
- Invite links/codes, webhook URLs, provider tokens, or destination secrets.
- Full URLs with query strings, full request/response bodies, raw support text, prompts, comments, notes, or descriptions.
- Generic page views, auth page views, modal opens, hovers, local UI toggles, and debug logs as first-batch SaaSFunnels events.

## Acceptance criteria

- Direct API delivery runs from backend/server code only.
- The real ingest key is stored in server environment variables and never appears in browser, mobile, desktop, or public client code.
- At least one account-scoped \`direct_api_now\` event is emitted after durable success.
- Retryable completed events include a stable \`event_id\` or deterministic idempotency key.
- \`first_*\` milestones are only emitted when persisted state proves first occurrence race-safely.
- No secrets, raw PII, query strings, full request/response bodies, stack traces, or free-text content are sent.
- Existing Stripe, PostHog, Segment, Web SDK, or backend event flows are not removed.
- A test or manual smoke check confirms one Direct API event appears in SaaSFunnels Direct API Activity and normalizes to the expected account.
`;
}
function buildSkillFileContents(endpoint, eventPlan) {
  return `---
name: ${skillName}
description: Identify revenue-relevant product, billing, lifecycle, support, and setup events in a codebase and implement them through SaaSFunnels Direct API with privacy, account identity, backend-only delivery, idempotency, and smoke-test safeguards.
---

# SaaSFunnels Event Discovery

Use this skill to inspect an app and decide which events should be sent to SaaSFunnels through Direct API. SaaSFunnels is a revenue decisioning layer, not a generic analytics sink. Prefer fewer, higher-signal events that explain activation, usage, limits, expansion intent, contraction risk, conversion, and support friction.

## Direct API Contract

- Endpoint: \`${endpoint}\`
- Auth header: \`Authorization: Bearer ${ingestKeyPlaceholder}\`
- Store the real ingest key in backend/server environment variables only.
- Never expose the ingest key in browser, mobile, desktop, or public client code.
- Every P0/P1 event needs \`account_id\`; use \`user_id\` only as actor context.
- Include default account facts in bounded \`properties\` when available: \`account_created_at\`, \`plan\`, \`subscription_status\`, \`is_in_trial\`, \`trial_ends_at\`, \`user_count\`, \`active_user_count\`, and \`seat_count\`.
- Emit backend/server events after durable database, credential, billing, OAuth, or provider persistence succeeds.
- Keep analytics failures non-blocking for product flows.

## Discovery Workflow

1. Search for existing analytics wrappers, product actions, billing code, integrations, jobs, webhooks, and database models.
2. Identify the account object: account, organization, workspace, company, tenant, team, customer, or project.
3. Prioritize activation, usage, limit friction, upgrade intent, checkout, downgrade/cancel, team expansion, setup milestones, and support friction.
4. Choose backend Direct API for authoritative state changes and use frontend analytics only for intent that cannot be observed server-side.
5. Produce an event plan with event name, trigger, code location, insertion point, identifiers, properties, privacy notes, idempotency, and smoke-test checks.
${eventPlanMarkdown(eventPlan)}

## Minimum SaaS Account Facts

Capture the ordinary account facts SaaSFunnels needs for account tracking and signal quality:

- Product signup date: \`account_created_at\`, \`signup_at\`, or \`customer_created_at\`.
- Login activity: \`user_logged_in\` or \`session_started\` events with \`semantic_type: "login"\` and \`user_id\`.
- Plan/lifecycle: \`plan\`, \`plan_name\`, \`current_plan\`, \`account_status\`, or \`subscription_status\`.
- Trial state: \`is_in_trial\`, \`trial_started_at\`, and \`trial_ends_at\`; Stripe wins for billing/trial fields when connected.
- Team shape: \`user_count\`, \`active_user_count\`, \`seat_count\`, or \`member_count\`.

Send these as bounded event properties or account traits from source-of-truth backend state. Do not send raw user lists, emails, support text, secrets, tokens, cookies, query strings, or free-form cancellation text.

## Good First Events

- \`account_signed_up\`
- \`account_activated\`
- \`user_logged_in\`
- \`usage_limit_hit\`
- \`upgrade_clicked\`
- \`checkout_started\`
- \`checkout_completed\`
- \`team_member_invited\`
- \`integration_configured\`
- \`destination_configured\`
- \`support_friction_seen\`

## Setup Milestones

- Emit \`direct_api_key_created\`, \`integration_configured\`, and \`destination_configured\` only after backend persistence succeeds.
- Emit \`first_event_ingested\`, \`first_integration_event_received\`, and other \`first_*\` milestones only when durable state proves first occurrence race-safely.
- If first-occurrence detection is approximate, skip or downgrade the event.

## Payload Example

\`\`\`json
${directApiJsonExample()}
\`\`\`

## Privacy And Safety

Do not send raw PII, passwords, tokens, cookies, signatures, auth headers, API keys, session values, invite links/codes, webhook URLs, provider tokens, destination secrets, full URLs with query strings, full request/response bodies, raw support text, prompts, comments, notes, or descriptions.

## Smoke Test

Send one account-scoped activation or usage event from backend/server code. Verify raw ingest, normalized event, expected account identity, stable source event id, useful rejection diagnostics, and no stored secrets or raw PII.
`;
}
function buildCursorRuleContents(endpoint, eventPlan) {
  return `---
description: Discover revenue-relevant events for SaaSFunnels Direct API instrumentation
alwaysApply: false
---

# SaaSFunnels Direct API Event Discovery

When asked to instrument SaaSFunnels, inspect the app first and add only revenue-relevant events through Direct API.

- Endpoint: \`${endpoint}\`
- Auth: \`Authorization: Bearer ${ingestKeyPlaceholder}\`
- Send from backend/server code only.
- Never expose the ingest key in browser, mobile, desktop, or public client code.
- Every P0/P1 event must include \`account_id\`.
- Include default SaaS account facts when available: signup date, login events, plan/status, trial state, user counts, active users, and seat counts. Stripe is authoritative for billing/trial facts when connected.
- Prefer completed backend state changes over client clicks.
- Use static lower_snake_case names and compact properties.
- Require deterministic IDs for retries and race-safe state for \`first_*\` milestones.
- Do not send raw PII, auth headers, tokens, API keys, invite links/codes, webhook URLs, query strings, full request/response bodies, or raw free-form text.

Prioritize activation, usage, limit friction, upgrade intent, checkout, downgrade/cancel intent, team expansion, setup milestones, and support friction. Smoke-test one account-scoped event and verify raw ingest, normalization, account identity, and redaction.
${eventPlanMarkdown(eventPlan)}
`;
}
function buildPrompt(toolLabel, endpoint, eventPlan) {
  const eventPlanText = eventPlan?.eventFamilies.length ? `
Selected revenue motions: ${eventPlan.selectedUseCases.join(", ") || "not selected"}.
Prioritize event families: ${eventPlan.eventFamilies.slice(0, 8).map((family) => `${family.semanticType} (${family.required ? "required" : "helpful"})`).join(", ")}.
` : "";
  return `Use the installed SaaSFunnels Event Discovery guidance for ${toolLabel}. Inspect this codebase and implement the first safe Direct API events.

Endpoint: ${endpoint}
Auth placeholder: Authorization: Bearer ${ingestKeyPlaceholder}
${eventPlanText}

Requirements:
- Use backend/server code only.
- Do not expose or paste the real ingest key.
- Require account_id for P0/P1 events.
- Include default SaaS account facts when available: signup date, login events, plan/status, trial state, user counts, active users, and seat counts.
- Treat Stripe as authoritative for billing/trial facts when connected.
- Prefer completed durable state changes.
- Avoid PII, secrets, query strings, raw support text, and full request/response bodies.
- Treat first_* events as blocked unless durable state proves first occurrence race-safely.
- Add tests or smoke checks that prove one account-scoped event reaches SaaSFunnels safely.`;
}
function buildInstallCommand(targetPath, fileContents) {
  const delimiter = "SAASFUNNELS_EVENT_DISCOVERY_INSTALL";
  if (fileContents.includes(delimiter)) {
    throw new Error("Install command delimiter appears in generated file contents.");
  }
  const targetDir = targetPath.split("/").slice(0, -1).join("/");
  return `mkdir -p ${targetDir}
cat > ${targetPath} <<'${delimiter}'
${fileContents}
${delimiter}`;
}
function toolHandoff(input) {
  return {
    fileContents: input.fileContents,
    installCommand: buildInstallCommand(input.targetPath, input.fileContents),
    label: input.label,
    prompt: buildPrompt(input.label, input.endpoint, input.eventPlan),
    targetPath: input.targetPath
  };
}
function getDirectApiAgentHandoff({ endpoint, eventPlan }) {
  const skillFileContents = buildSkillFileContents(endpoint, eventPlan);
  const cursorFileContents = buildCursorRuleContents(endpoint, eventPlan);
  return {
    briefMarkdown: buildBriefMarkdown(endpoint, eventPlan),
    tools: {
      "claude-code": toolHandoff({
        endpoint,
        eventPlan,
        fileContents: skillFileContents,
        label: "Claude Code",
        targetPath: ".claude/skills/saasfunnels-event-discovery/SKILL.md"
      }),
      codex: toolHandoff({
        endpoint,
        eventPlan,
        fileContents: skillFileContents,
        label: "Codex",
        targetPath: ".agents/skills/saasfunnels-event-discovery/SKILL.md"
      }),
      cursor: toolHandoff({
        endpoint,
        eventPlan,
        fileContents: cursorFileContents,
        label: "Cursor",
        targetPath: ".cursor/rules/saasfunnels-event-discovery.mdc"
      })
    },
    version: DIRECT_API_AGENT_HANDOFF_VERSION
  };
}

import { createHash } from "node:crypto";

var stripeEventDataTypes = [
  "checkout.session.completed",
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed"
];
var stripeEventDataTypeSet = new Set(stripeEventDataTypes);

var MAX_EVENT_NAME_LENGTH = 128;
var MAX_FUTURE_EVENT_MS = 24 * 60 * 60 * 1e3;
var semanticEventTypes = [
  "usage",
  "activation",
  "limit_friction",
  "upgrade_intent",
  "downgrade_intent",
  "team_expansion",
  "topup",
  "cancel_intent",
  "checkout",
  "login",
  "billing_lifecycle",
  "support_friction",
  "integration_connected"
];
var eventKinds = [
  "page_view",
  "button_click",
  "login",
  "product_action",
  "billing_event",
  "friction_event",
  "unknown"
];
var eventSentiments = [
  "positive",
  "neutral",
  "negative",
  "unknown"
];
var eventSentimentSources = [
  "explicit",
  "inferred",
  "ai",
  "integration",
  "unknown"
];
var featureFunnelSemanticTypes = /* @__PURE__ */ new Map([
  ["feature_access_denied", "limit_friction"],
  ["feature_limit_warning", "limit_friction"],
  ["feature_limit_reached", "limit_friction"],
  ["feature_trial_started", "activation"],
  ["feature_trial_ended", "billing_lifecycle"],
  ["feature_access_adopted", "activation"]
]);
var semanticHints = [
  [
    "usage",
    [
      "usage",
      "used",
      "consumed",
      "credits",
      "api_call",
      "generation",
      "export"
    ]
  ],
  [
    "activation",
    [
      "activated",
      "aha",
      "api_key_created",
      "completed_setup",
      "destination_configured",
      "first_event",
      "first_value",
      "inbound_source_key_created",
      "integration_configured",
      "mapping_suggestion_accepted",
      "onboarded",
      "onboarding_completed",
      "source_key_created",
      "workspace_created"
    ]
  ],
  [
    "limit_friction",
    ["limit", "quota", "cap", "blocked", "overage", "paywall"]
  ],
  [
    "checkout",
    ["checkout_started", "checkout", "payment_started", "checkout_completed"]
  ],
  [
    "billing_lifecycle",
    [
      "billing_lifecycle",
      "billing_status",
      "billing_action",
      "customer.created",
      "customer.subscription.",
      "customer.updated",
      "invoice",
      "payment_failed",
      "payment_recovered",
      "payment_succeeded",
      "plan_changed",
      "subscription_canceled",
      "subscription_cancelled",
      "subscription_created",
      "subscription_deleted",
      "subscription_downgraded",
      "subscription_paused",
      "subscription_updated",
      "subscription_upgraded"
    ]
  ],
  [
    "upgrade_intent",
    ["pricing", "upgrade", "plan_compare", "premium", "growth_plan"]
  ],
  [
    "team_expansion",
    ["invite", "seat", "member", "teammate", "workspace_user"]
  ],
  ["topup", ["topup", "top_up", "credit_pack", "overage_purchase"]],
  ["downgrade_intent", ["downgrade", "plan_down", "reduce_plan", "right_size"]],
  ["cancel_intent", ["cancel", "pause", "delete_workspace"]],
  [
    "login",
    [
      "login",
      "logged_in",
      "logged in",
      "signed_in",
      "signed in",
      "session_started",
      "session started"
    ]
  ],
  [
    "support_friction",
    ["support", "error", "failed", "ticket", "complaint", "friction"]
  ],
  [
    "integration_connected",
    ["integration_connected", "connected_integration", "oauth_connected"]
  ]
];
var eventKindHints = [
  [
    "page_view",
    ["page_view", "page viewed", "screen_view", "pricing_viewed", "viewed"]
  ],
  ["button_click", ["button", "click", "clicked", "cta", "press"]],
  [
    "login",
    [
      "login",
      "logged_in",
      "logged in",
      "signed_in",
      "signed in",
      "session_started",
      "session started"
    ]
  ],
  [
    "billing_event",
    [
      "invoice",
      "subscription",
      "payment",
      "checkout",
      "topup",
      "top_up",
      "stripe"
    ]
  ],
  ["friction_event", ["error", "failed", "support", "ticket", "complaint"]],
  [
    "product_action",
    [
      "usage",
      "used",
      "activated",
      "invite",
      "export",
      "generation",
      "integration",
      "onboarding_completed",
      "workspace_created"
    ]
  ]
];
var sensitiveKeyPattern = /(authorization|token|secret|password|session|cookie|email|invite|key|signature)/i;
var rawNavigationKeyPattern = /^(url|referrer|\$current_url|\$referrer)$/i;
var emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
var emailTestPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
var tokenLikePattern = /\b((?:sk|pk|rk|whsec|xox[baprs]|gh[pousr])_[A-Za-z0-9_=-]{12,}|[A-Za-z0-9_-]{32,})\b/g;
var eventNameTokenPattern = /\b((?:sk|pk|rk|whsec|xox[baprs]|gh[pousr])_[A-Za-z0-9_=-]{12,}|[A-Za-z0-9_-]{48,})\b/i;
var isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T/;
var semanticEventTypeSet = new Set(semanticEventTypes);
var eventKindSet = new Set(eventKinds);
var eventSentimentSet = new Set(eventSentiments);
var eventSentimentSourceSet = new Set(eventSentimentSources);
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function firstStringValue(fields) {
  for (const [name, value] of fields) {
    if (value === void 0 || value === null) continue;
    if (typeof value !== "string") return { error: `${name} must be a string` };
    const trimmed = value.trim();
    if (trimmed) return { value: trimmed };
  }
  return {};
}
function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return void 0;
}
function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
var accountTraitKeys = [
  "account_created_at",
  "accountCreatedAt",
  "active_user_count",
  "activeUserCount",
  "customer_created_at",
  "customerCreatedAt",
  "created_at",
  "createdAt",
  "current_plan",
  "currentPlan",
  "is_in_trial",
  "isInTrial",
  "lifecycle_stage",
  "lifecycleStage",
  "licensed_seats",
  "member_count",
  "memberCount",
  "plan",
  "plan_name",
  "planName",
  "seat_count",
  "seatCount",
  "seats",
  "signup_at",
  "signupAt",
  "signup_date",
  "signupDate",
  "status",
  "account_status",
  "accountStatus",
  "subscription_status",
  "trial_end",
  "trialEnd",
  "trial_end_at",
  "trialEndAt",
  "trial_ends_at",
  "trialEndsAt",
  "trial_start",
  "trialStart",
  "trial_started_at",
  "trialStartedAt",
  "trialing",
  "user_count",
  "userCount",
  "users"
];
var explicitTopLevelAccountTraitKeys = accountTraitKeys.filter(
  (key2) => ![
    "created_at",
    "createdAt",
    "current_plan",
    "currentPlan",
    "plan",
    "status",
    "users"
  ].includes(key2)
);
function boundedTraitValue(value) {
  if (typeof value === "string") return value.trim() ? value.trim() : void 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return void 0;
}
function pickAccountTraits(records, keys = accountTraitKeys) {
  const traits = {};
  for (const record of records) {
    for (const key2 of keys) {
      const value = boundedTraitValue(record[key2]);
      if (value !== void 0) traits[key2] = value;
    }
  }
  return traits;
}
function nestedGroupTraits(value) {
  const group = objectValue(value);
  return {
    ...group,
    ...objectValue(group.traits)
  };
}
function accountTraitsFromPayload({
  body,
  context,
  properties
}) {
  return pickAccountTraits(
    [
      objectValue(properties.traits),
      objectValue(properties.account),
      objectValue(properties.customer),
      objectValue(properties.company),
      objectValue(properties.organization),
      objectValue(properties.group_properties),
      objectValue(properties.groupProperties),
      objectValue(properties.group_traits),
      objectValue(properties.groupTraits),
      objectValue(properties.$group_set),
      objectValue(body.traits),
      objectValue(body.account),
      objectValue(body.customer),
      nestedGroupTraits(body.group),
      objectValue(context.traits),
      objectValue(context.account),
      nestedGroupTraits(context.group)
    ],
    accountTraitKeys
  );
}
function redactString(value) {
  return value.replace(emailPattern, "[redacted-email]").replace(tokenLikePattern, "[redacted-token]");
}
function isIdentifierKey(key2) {
  return /^(account_id|account_key|workspace_id)$/i.test(key2);
}
function isBusinessMetadataKey(key2) {
  return /^(feature_key|is_key_feature|product_key|metric_key)$/i.test(key2);
}
function isSensitiveKey(key2, options) {
  if (options.preserveIdentifierValues && isIdentifierKey(key2)) return false;
  if (isBusinessMetadataKey(key2)) return false;
  return sensitiveKeyPattern.test(key2);
}
function preservesIdentifierValue(key2, options) {
  return Boolean(options.preserveIdentifierValues && isIdentifierKey(key2));
}
function isRawNavigationKey(key2) {
  return rawNavigationKeyPattern.test(key2);
}
function validateEventName(eventName) {
  if (eventName.length > MAX_EVENT_NAME_LENGTH)
    return `event_name must be ${MAX_EVENT_NAME_LENGTH} characters or fewer`;
  if (emailTestPattern.test(eventName) || eventNameTokenPattern.test(eventName))
    return "event_name must not contain emails or token-like secrets";
  return null;
}
function semanticTypeValue(value) {
  const candidate = stringValue(value);
  return candidate && semanticEventTypeSet.has(candidate) ? candidate : void 0;
}
function eventKindValue(value) {
  const candidate = stringValue(value);
  return candidate && eventKindSet.has(candidate) ? candidate : void 0;
}
function sentimentValue(value) {
  const candidate = stringValue(value)?.toLowerCase();
  return candidate && eventSentimentSet.has(candidate) ? candidate : void 0;
}
function sentimentSourceValue(value) {
  const candidate = stringValue(value)?.toLowerCase();
  return candidate && eventSentimentSourceSet.has(candidate) ? candidate : void 0;
}
function sentimentFromScore(score) {
  if (score > 0.05) return "positive";
  if (score < -0.05) return "negative";
  return "neutral";
}
function scoreForSentiment(sentiment) {
  if (sentiment === "positive") return 1;
  if (sentiment === "negative") return -1;
  if (sentiment === "neutral") return 0;
  return void 0;
}
function normalizeSentiment(fields, properties) {
  const rawScore = numberValue(fields.sentiment_score) ?? numberValue(fields.sentimentScore) ?? numberValue(properties.sentiment_score) ?? numberValue(properties.sentimentScore);
  const sentimentScore = rawScore === void 0 ? void 0 : clampNumber(rawScore, -1, 1);
  const sentiment = sentimentValue(fields.sentiment) ?? sentimentValue(fields.sentiment_label) ?? sentimentValue(fields.sentimentLabel) ?? sentimentValue(properties.sentiment) ?? sentimentValue(properties.sentiment_label) ?? sentimentValue(properties.sentimentLabel) ?? (sentimentScore === void 0 ? "unknown" : sentimentFromScore(sentimentScore));
  const inferredScore = sentimentScore ?? scoreForSentiment(sentiment);
  const rawConfidence = numberValue(fields.sentiment_confidence) ?? numberValue(fields.sentimentConfidence) ?? numberValue(properties.sentiment_confidence) ?? numberValue(properties.sentimentConfidence);
  const sentimentConfidence = rawConfidence === void 0 ? void 0 : clampNumber(rawConfidence, 0, 1);
  const candidateSentimentSource = sentimentSourceValue(fields.sentiment_source) ?? sentimentSourceValue(fields.sentimentSource) ?? sentimentSourceValue(properties.sentiment_source) ?? sentimentSourceValue(properties.sentimentSource);
  const sentimentSource = sentiment === "unknown" ? "unknown" : candidateSentimentSource ?? "explicit";
  return {
    sentiment,
    sentiment_confidence: sentimentConfidence,
    sentiment_score: sentiment === "unknown" ? void 0 : inferredScore,
    sentiment_source: sentimentSource
  };
}
function normalizeProductTimestamp(fields, now = /* @__PURE__ */ new Date()) {
  for (const [name, value] of fields) {
    if (value === void 0 || value === null || value === "") continue;
    if (typeof value !== "string")
      return { error: `${name} must be an ISO-8601 string` };
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!isoTimestampPattern.test(trimmed))
      return { error: `${name} must be an ISO-8601 string` };
    const parsed = new Date(trimmed);
    const timestamp3 = parsed.getTime();
    if (!Number.isFinite(timestamp3))
      return { error: `${name} must be a valid ISO-8601 timestamp` };
    if (timestamp3 > now.getTime() + MAX_FUTURE_EVENT_MS)
      return { error: `${name} cannot be more than 24 hours in the future` };
    return { timestamp: parsed.toISOString() };
  }
  return { timestamp: now.toISOString() };
}
function redactPayload(value, depth = 0, options = {}) {
  if (depth > 5) return "[redacted-depth]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => redactPayload(item, depth + 1, options));
  if (!value || typeof value !== "object") return void 0;
  const redacted = {};
  for (const [key2, nestedValue] of Object.entries(
    value
  )) {
    redacted[key2] = isSensitiveKey(key2, options) ? "[redacted]" : isRawNavigationKey(key2) ? sanitizeUrl(nestedValue) : preservesIdentifierValue(key2, options) ? nestedValue : redactPayload(nestedValue, depth + 1, options);
  }
  return redacted;
}
function sanitizeUrl(value) {
  const raw = stringValue(value);
  if (!raw) return {};
  try {
    const parsed = new URL(
      raw,
      raw.startsWith("/") ? "https://app.local" : void 0
    );
    const utmParams = {};
    for (const [key2, paramValue] of parsed.searchParams.entries()) {
      if (key2.startsWith("utm_")) utmParams[key2] = redactString(paramValue);
    }
    return {
      host: parsed.hostname === "app.local" ? void 0 : parsed.hostname,
      path: parsed.pathname,
      utmParams
    };
  } catch {
    return {};
  }
}
function propertiesWithoutRawNavigation(properties) {
  const sanitized = { ...properties };
  for (const key2 of ["url", "referrer", "$current_url", "$referrer"]) {
    delete sanitized[key2];
  }
  return sanitized;
}
function inferSemanticType(eventName) {
  const normalized = eventName.toLowerCase();
  const featureSemanticType = featureFunnelSemanticTypes.get(normalized);
  if (featureSemanticType) return featureSemanticType;
  return semanticHints.find(
    ([, hints]) => hints.some((hint) => normalized.includes(hint))
  )?.[0];
}
function inferEventKind(eventName, source, semanticType2) {
  if (source === "stripe") return "billing_event";
  if (semanticType2 === "login") return "login";
  if (semanticType2 === "support_friction") return "friction_event";
  if (semanticType2 === "checkout" || semanticType2 === "topup" || semanticType2 === "billing_lifecycle")
    return "billing_event";
  const normalized = eventName.toLowerCase();
  return eventKindHints.find(
    ([, hints]) => hints.some((hint) => normalized.includes(hint))
  )?.[0] ?? (semanticType2 ? "product_action" : "unknown");
}
function isRevenueRelevantEvent(event) {
  if (event.event_name === "app_page_viewed" || event.event_name === "auth_page_viewed")
    return false;
  if (event.source === "web_sdk" && event.event_kind === "page_view" && !event.semantic_type)
    return false;
  if (event.semantic_type) return true;
  if (event.event_kind && event.event_kind !== "unknown") return true;
  const haystack = `${event.event_name} ${JSON.stringify(event.properties ?? {})}`.toLowerCase();
  return [
    "pricing",
    "upgrade",
    "downgrade",
    "cancel",
    "checkout",
    "billing",
    "invite",
    "limit",
    "error"
  ].some((term) => haystack.includes(term));
}
function buildIdempotencyKey(event) {
  if (event.source_event_id) return `${event.source}:${event.source_event_id}`;
  return createHash("sha256").update(
    JSON.stringify({
      account_id: event.account_id,
      event_name: event.event_name,
      occurred_at: event.timestamp,
      properties: event.properties,
      source: event.source,
      user_id: event.user_id,
      workspace_id: event.workspace_id
    })
  ).digest("hex");
}
function normalizeEventPayload(body, source) {
  const properties = objectValue(body.properties);
  const context = objectValue(body.context);
  const page = objectValue(context.page);
  const eventNameResult = firstStringValue([
    ["event_name", body.event_name],
    ["event", body.event],
    ["name", body.name],
    ["type", body.type]
  ]);
  if (eventNameResult.error) return { error: eventNameResult.error };
  const eventName = eventNameResult.value ?? "";
  if (!eventName) {
    return { error: "event_name is required" };
  }
  const eventNameError = validateEventName(eventName);
  if (eventNameError) return { error: eventNameError };
  const accountIdResult = firstStringValue([
    ["account_id", body.account_id],
    ["groupId", body.groupId],
    ["properties.account_id", properties.account_id],
    ["properties.group_id", properties.group_id],
    ["properties.company_id", properties.company_id]
  ]);
  if (accountIdResult.error) return { error: accountIdResult.error };
  const accountId = accountIdResult.value;
  if (!accountId) {
    return { error: "account_id or groupId is required" };
  }
  const timestampResult = normalizeProductTimestamp([
    ["timestamp", body.timestamp],
    ["sentAt", body.sentAt],
    ["occurred_at", body.occurred_at]
  ]);
  if (timestampResult.error || !timestampResult.timestamp)
    return { error: timestampResult.error ?? "timestamp is invalid" };
  const semanticType2 = semanticTypeValue(body.semantic_type) ?? semanticTypeValue(body.event_type) ?? semanticTypeValue(properties.semantic_type) ?? (source === "stripe" ? void 0 : inferSemanticType(eventName));
  const eventKind = eventKindValue(body.event_kind) ?? eventKindValue(properties.event_kind) ?? inferEventKind(eventName, source, semanticType2);
  const sentiment = normalizeSentiment(body, properties);
  const url = sanitizeUrl(
    body.url ?? properties.url ?? properties.$current_url ?? page.url
  );
  const referrer = sanitizeUrl(
    body.referrer ?? properties.referrer ?? properties.$referrer ?? page.referrer
  );
  const accountTraits = {
    ...accountTraitsFromPayload({ body, context, properties }),
    ...pickAccountTraits([body], explicitTopLevelAccountTraitKeys)
  };
  const existingTraits = objectValue(properties.traits);
  const mergedTraits = {
    ...existingTraits,
    ...accountTraits
  };
  const sanitizedProperties = redactPayload(
    {
      ...propertiesWithoutRawNavigation(properties),
      ...Object.keys(mergedTraits).length > 0 ? { traits: mergedTraits } : {},
      ...Object.keys(url).length > 0 ? { sanitized_url: url } : {},
      ...Object.keys(referrer).length > 0 ? { sanitized_referrer: referrer } : {}
    },
    0,
    { preserveIdentifierValues: source === "stripe" }
  );
  const eventWithoutKey = {
    account_id: accountId,
    anonymous_id: stringValue(body.anonymousId) ?? stringValue(properties.anonymous_id) ?? stringValue(properties.anonymousId),
    event_kind: eventKind,
    event_name: eventName,
    properties: sanitizedProperties,
    referrer_host: typeof referrer.host === "string" ? referrer.host : void 0,
    semantic_type: semanticType2,
    sentiment: sentiment.sentiment,
    sentiment_confidence: sentiment.sentiment_confidence,
    sentiment_score: sentiment.sentiment_score,
    sentiment_source: sentiment.sentiment_source,
    session_id: stringValue(body.session_id) ?? stringValue(body.sessionId) ?? stringValue(properties.session_id) ?? stringValue(properties.sessionId) ?? stringValue(properties.$session_id),
    source,
    source_event_id: stringValue(body.messageId) ?? stringValue(body.event_id) ?? stringValue(body.id) ?? stringValue(properties.event_id) ?? stringValue(properties.uuid),
    timestamp: timestampResult.timestamp,
    url_host: typeof url.host === "string" ? url.host : void 0,
    url_path: typeof url.path === "string" ? url.path : void 0,
    user_id: stringValue(body.user_id) ?? stringValue(body.userId) ?? stringValue(properties.user_id) ?? stringValue(properties.userId) ?? stringValue(properties.distinct_id),
    value: numberValue(body.value) ?? numberValue(properties.value) ?? numberValue(properties.amount) ?? numberValue(properties.quantity),
    workspace_id: stringValue(body.workspace_id) ?? stringValue(properties.workspace_id) ?? stringValue(context.workspace_id) ?? "demo-workspace"
  };
  const event = {
    ...eventWithoutKey,
    idempotency_key: buildIdempotencyKey(eventWithoutKey)
  };
  return {
    event,
    revenueRelevant: isRevenueRelevantEvent(event)
  };
}
function posthogToNormalized(body) {
  const wrappedEvent = objectValue(body.event);
  const hasWrappedEvent = Object.keys(wrappedEvent).length > 0;
  const payload = hasWrappedEvent ? wrappedEvent : body;
  const payloadProperties = objectValue(payload.properties);
  const bodyProperties = objectValue(body.properties);
  const properties = {
    ...payloadProperties,
    ...bodyProperties
  };
  const postHogGroups = {
    ...objectValue(properties.$groups),
    ...objectValue(properties.groups),
    ...objectValue(payload.groups),
    ...objectValue(body.groups)
  };
  const groupAccountId = stringValue(postHogGroups.workspace) ?? stringValue(postHogGroups.account) ?? stringValue(postHogGroups.company) ?? stringValue(postHogGroups.organization) ?? stringValue(postHogGroups.org) ?? stringValue(postHogGroups.tenant) ?? stringValue(postHogGroups.team) ?? Object.values(postHogGroups).find(
    (value) => typeof value === "string" && value.trim().length > 0
  );
  const sourceWorkspaceId = stringValue(payloadProperties.workspace_id);
  return normalizeEventPayload(
    {
      account_id: properties.account_id ?? properties.group_id ?? properties.company_id ?? groupAccountId ?? sourceWorkspaceId,
      event_id: payload.uuid ?? payload.id ?? body.uuid ?? body.id,
      event_name: stringValue(payload.event_name) ?? stringValue(payload.event) ?? stringValue(payload.name) ?? stringValue(body.event_name) ?? (typeof body.event === "string" ? body.event : void 0) ?? stringValue(body.name),
      properties,
      session_id: properties.session_id ?? properties.sessionId ?? properties.$session_id,
      timestamp: payload.timestamp ?? body.timestamp,
      user_id: payload.distinct_id ?? body.distinct_id ?? properties.distinct_id,
      value: properties.value,
      workspace_id: body.workspace_id ?? bodyProperties.workspace_id ?? properties.workspace_id
    },
    "posthog"
  );
}
function posthogEventNameFromPayload(body) {
  const wrappedEvent = objectValue(body.event);
  const payload = Object.keys(wrappedEvent).length > 0 ? wrappedEvent : body;
  return stringValue(payload.event_name) ?? stringValue(payload.event) ?? stringValue(payload.name) ?? stringValue(body.event_name) ?? (typeof body.event === "string" ? body.event.trim() || void 0 : void 0) ?? stringValue(body.name);
}
function segmentToNormalized(body) {
  const context = objectValue(body.context);
  return normalizeEventPayload(
    {
      account_id: body.groupId,
      anonymousId: body.anonymousId,
      event_name: body.event,
      messageId: body.messageId,
      properties: body.properties,
      sentAt: body.sentAt,
      session_id: body.session_id ?? body.sessionId ?? context.session_id ?? context.sessionId,
      timestamp: body.timestamp,
      traits: body.traits,
      type: body.type,
      userId: body.userId,
      workspace_id: body.workspace_id ?? context.workspace_id
    },
    "segment"
  );
}

var inboundSourceContracts = {
  posthog: {
    authSummary: "Authorization: Bearer <posthog_ingest_key>; workspace is resolved server-side from the scoped key.",
    defaultKeyName: "PostHog ingest key",
    docsUrl: "https://posthog.com/docs/cdp/destinations/webhook",
    endpoint: "/api/events/posthog",
    eventSource: "posthog",
    key: "posthog",
    name: "PostHog",
    recommendedAllowlist: [
      "pricing_viewed",
      "workspace_created",
      "onboarding_completed",
      "upgrade_clicked",
      "limit_hit",
      "workspace_invited",
      "integration_connected",
      "integration_configured",
      "direct_api_key_created",
      "inbound_source_key_created",
      "destination_configured",
      "team_member_invited",
      "event_mapping_suggestion_accepted",
      "downgrade_page_viewed",
      "cancel_started"
    ],
    requiredFields: [
      "event",
      "uuid or id",
      "timestamp",
      "properties.distinct_id",
      "properties.account_id, properties.group_id, properties.workspace_id, or $groups.workspace",
      "recommended account facts: account_created_at, plan, is_in_trial, trial_ends_at, user_count, active_user_count, seat_count"
    ],
    samplePayload: {
      event: "onboarding_completed",
      properties: {
        account_created_at: "2026-06-01T12:00:00.000Z",
        active_user_count: 6,
        app_area: "onboarding",
        distinct_id: "user_456",
        is_in_trial: true,
        plan: "starter",
        seat_count: 10,
        trial_ends_at: "2026-06-28T12:00:00.000Z",
        workspace_id: "acct_or_workspace_123"
      },
      timestamp: "2026-06-20T15:00:00.000Z",
      uuid: "ph_evt_001"
    },
    scope: "posthog:write",
    setupSteps: [
      "Create a PostHog-scoped ingest key in SaaSFunnels.",
      "Create a PostHog Data Pipelines webhook destination.",
      "Set the destination URL to the SaaSFunnels PostHog endpoint.",
      "Send the key as Authorization: Bearer <key>.",
      "Forward only custom revenue/product events with account identity fields from the Data Pipeline destination.",
      "Forward bounded account facts when available: account_created_at, plan, subscription_status, is_in_trial, trial_ends_at, user_count, active_user_count, and seat_count.",
      "For SaaSFunnels app events, keep properties.workspace_id in the forwarded payload; SaaSFunnels uses it as the customer/account identity.",
      "Exclude PostHog SDK/system events whose names begin with $ before they reach SaaSFunnels."
    ],
    testPlan: "Send a custom PostHog product event and confirm SaaSFunnels shows a recent normalized PostHog event. PostHog's destination test button sends $pageview, which appears only as a diagnostic."
  },
  segment: {
    authSummary: "Authorization: Bearer <segment_ingest_key>; workspace is resolved server-side from the scoped key.",
    defaultKeyName: "Segment ingest key",
    docsUrl: "https://docs.segmentapis.com/tag/Destinations/",
    endpoint: "/api/events/segment",
    eventSource: "segment",
    key: "segment",
    name: "Segment",
    recommendedAllowlist: ["Product Used", "Account Activated", "Limit Hit", "Upgrade Clicked", "Checkout Started", "Subscription Updated", "Team Invited"],
    requiredFields: [
      "messageId",
      "event or type",
      "userId",
      "groupId",
      "timestamp or sentAt",
      "properties",
      "recommended account facts: account_created_at, plan, is_in_trial, trial_ends_at, user_count, active_user_count, seat_count"
    ],
    samplePayload: {
      event: "Upgrade Clicked",
      groupId: "acct_123",
      messageId: "seg_evt_001",
      properties: {
        account_created_at: "2026-06-01T12:00:00.000Z",
        active_user_count: 6,
        is_in_trial: true,
        plan: "starter",
        seat_count: 10,
        trial_ends_at: "2026-06-28T12:00:00.000Z",
        value: 1
      },
      timestamp: "2026-06-20T15:00:00.000Z",
      type: "track",
      userId: "user_456"
    },
    scope: "segment:write",
    setupSteps: [
      "Create a Segment-scoped ingest key in SaaSFunnels.",
      "Configure a Segment webhook/custom destination for the workspace source.",
      "Set the destination URL to the SaaSFunnels Segment endpoint.",
      "Send the key as Authorization: Bearer <key>.",
      "Forward track/group payloads with groupId or equivalent account identity.",
      "Forward bounded account facts when available: account_created_at, plan, subscription_status, is_in_trial, trial_ends_at, user_count, active_user_count, and seat_count."
    ],
    testPlan: "Send a Segment track or group test payload and confirm SaaSFunnels shows a recent normalized Segment event."
  }
};
var inboundSourceProviderKeys = Object.keys(inboundSourceContracts);

var signalFamilyContracts = [
  {
    backingRuleIds: ["upgrade_ready", "premium_feature_intent", "sales_assist"],
    defaultDestination: "slack",
    deliveryProviders: ["slack", "webhook"],
    description: "Usage and buying-intent evidence that points to expansion readiness.",
    label: "Expansion readiness",
    optionalSemanticTypes: ["upgrade_intent", "limit_friction", "team_expansion"],
    payloadFields: ["signal.family", "account.usage", "recommended_action"],
    predictionTargets: ["expansion", "upgrade"],
    requiredSemanticTypes: ["usage"],
    routeAudience: ["sales", "success"],
    signalFamilyKey: "expansion_readiness",
    useCases: ["expansion"]
  },
  {
    backingRuleIds: ["limit_expansion", "topup_to_plan"],
    defaultDestination: "slack",
    deliveryProviders: ["slack", "webhook"],
    description: "Repeated limit friction or top-up behavior that suggests a better-fit plan.",
    label: "Top-up / limit expansion",
    optionalSemanticTypes: ["topup", "upgrade_intent"],
    payloadFields: ["signal.family", "account.limits", "recommended_action"],
    predictionTargets: ["expansion", "topup"],
    requiredSemanticTypes: ["usage", "limit_friction"],
    routeAudience: ["sales", "success"],
    signalFamilyKey: "topup_limit_expansion",
    useCases: ["expansion", "topups_limits"]
  },
  {
    backingRuleIds: ["team_expansion", "team_invited_trial"],
    defaultDestination: "slack",
    deliveryProviders: ["slack", "webhook"],
    description: "Team invite or seat behavior that suggests expansion or team conversion.",
    label: "Team expansion",
    optionalSemanticTypes: ["activation"],
    payloadFields: ["signal.family", "account.team_activity", "recommended_action"],
    predictionTargets: ["team_expansion", "conversion"],
    requiredSemanticTypes: ["team_expansion"],
    routeAudience: ["sales", "success"],
    signalFamilyKey: "team_expansion",
    useCases: ["expansion", "trial_conversion"]
  },
  {
    backingRuleIds: ["trial_activated_not_paid", "free_user_high_usage", "integration_connected_trial", "team_invited_trial"],
    defaultDestination: "webhook",
    deliveryProviders: ["slack", "webhook"],
    description: "Activation evidence that a free or trial account may be ready for paid conversion.",
    label: "Trial conversion",
    optionalSemanticTypes: ["checkout", "team_expansion", "integration_connected"],
    payloadFields: ["signal.family", "account.activation", "recommended_action"],
    predictionTargets: ["trial_conversion", "conversion"],
    requiredSemanticTypes: ["activation"],
    routeAudience: ["sales", "revenue_ops"],
    signalFamilyKey: "trial_conversion",
    useCases: ["trial_conversion"]
  },
  {
    backingRuleIds: ["checkout_abandoned"],
    defaultDestination: "webhook",
    deliveryProviders: ["slack", "webhook"],
    description: "Checkout activity that needs recovery when payment or subscription completion is missing.",
    label: "Checkout recovery",
    optionalSemanticTypes: ["activation"],
    payloadFields: ["signal.family", "account.checkout", "recommended_action"],
    predictionTargets: ["checkout_recovery", "conversion"],
    requiredSemanticTypes: ["checkout"],
    routeAudience: ["revenue_ops"],
    signalFamilyKey: "checkout_recovery",
    useCases: ["trial_conversion"]
  },
  {
    backingRuleIds: ["usage_drop_risk", "login_drop_risk", "cancel_intent", "support_friction"],
    defaultDestination: "slack",
    deliveryProviders: ["slack", "webhook"],
    description: "Usage, login, support, or cancel evidence that should trigger a save motion.",
    label: "Churn / save risk",
    optionalSemanticTypes: ["login", "support_friction", "cancel_intent", "downgrade_intent"],
    payloadFields: ["signal.family", "account.risk", "recommended_action"],
    predictionTargets: ["churn", "save"],
    requiredSemanticTypes: ["usage"],
    routeAudience: ["success"],
    signalFamilyKey: "churn_save_risk",
    useCases: ["save"]
  },
  {
    backingRuleIds: ["downgrade_intent", "contraction_risk"],
    defaultDestination: "slack",
    deliveryProviders: ["slack", "webhook"],
    description: "Downgrade intent and usage evidence that suggests contraction risk.",
    label: "Downgrade / contraction risk",
    optionalSemanticTypes: ["usage"],
    payloadFields: ["signal.family", "account.contraction_risk", "recommended_action"],
    predictionTargets: ["contraction", "downgrade"],
    requiredSemanticTypes: ["downgrade_intent"],
    routeAudience: ["success"],
    signalFamilyKey: "downgrade_contraction_risk",
    useCases: ["save"]
  },
  {
    backingRuleIds: ["payment_risk_with_low_usage"],
    defaultDestination: "slack",
    deliveryProviders: ["slack", "webhook"],
    description: "Payment risk paired with weakening usage or save-motion evidence.",
    label: "Payment risk recovery",
    optionalSemanticTypes: ["usage", "login", "support_friction"],
    payloadFields: ["signal.family", "account.payment_risk", "recommended_action"],
    predictionTargets: ["payment_risk", "churn"],
    requiredSemanticTypes: [],
    routeAudience: ["success", "revenue_ops"],
    signalFamilyKey: "payment_risk_recovery",
    useCases: ["save"]
  },
  {
    backingRuleIds: ["annual_ready"],
    defaultDestination: "webhook",
    deliveryProviders: ["slack", "webhook"],
    description: "Healthy usage and billing stability that support annual or committed-spend outreach.",
    label: "Annual readiness",
    optionalSemanticTypes: ["activation", "upgrade_intent"],
    payloadFields: ["signal.family", "account.annual_readiness", "recommended_action"],
    predictionTargets: ["annualization", "expansion"],
    requiredSemanticTypes: ["usage"],
    routeAudience: ["sales", "success"],
    signalFamilyKey: "annual_readiness",
    useCases: ["annualization"]
  },
  {
    backingRuleIds: ["watchlist"],
    defaultDestination: "suppress",
    deliveryProviders: [],
    description: "Low-confidence or conflicting evidence that should be monitored instead of routed.",
    label: "Watch / suppress",
    optionalSemanticTypes: [],
    payloadFields: ["signal.family", "account.watch_reason"],
    predictionTargets: [],
    requiredSemanticTypes: [],
    routeAudience: ["internal"],
    signalFamilyKey: "watch_suppress",
    useCases: ["expansion", "save", "trial_conversion", "topups_limits", "annualization"]
  }
];
var signalFamilyContractByKey = Object.fromEntries(
  signalFamilyContracts.map((contract) => [contract.signalFamilyKey, contract])
);
var semanticTypeValues = /* @__PURE__ */ new Set([
  "usage",
  "activation",
  "limit_friction",
  "upgrade_intent",
  "downgrade_intent",
  "team_expansion",
  "topup",
  "cancel_intent",
  "checkout",
  "login",
  "support_friction",
  "integration_connected"
]);
function semanticType(value) {
  return value && semanticTypeValues.has(value) ? value : void 0;
}
function listLabel(values) {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}
function signalUnlockContextForSemanticType(value) {
  const normalized = semanticType(value);
  if (!normalized) return void 0;
  const families = signalFamilyContracts.filter((contract) => contract.requiredSemanticTypes.includes(normalized) || contract.optionalSemanticTypes.includes(normalized)).map((contract) => ({
    label: contract.label,
    required: contract.requiredSemanticTypes.includes(normalized),
    signalFamilyKey: contract.signalFamilyKey,
    useCases: contract.useCases
  })).sort((left, right) => Number(right.required) - Number(left.required) || left.label.localeCompare(right.label));
  if (families.length === 0) return void 0;
  const requiredFamilies = families.filter((family) => family.required);
  const primaryFamilies = (requiredFamilies.length > 0 ? requiredFamilies : families).slice(0, 3);
  const prefix = requiredFamilies.length > 0 ? "Can unlock" : "Can add evidence to";
  return {
    families,
    semanticType: normalized,
    summary: `${prefix} ${listLabel(primaryFamilies.map((family) => family.label))}.`
  };
}

var DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION = "2026-07-02.1";
var developerToolEventSources = ["direct", "posthog", "segment"];
var semanticTypeSet = new Set(semanticEventTypes);
var emailPattern2 = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
var tokenLikePattern2 = /\b((?:sk|pk|rk|whsec|xox[baprs]|gh[pousr])_[A-Za-z0-9_=-]{12,}|[A-Za-z0-9_-]{32,})\b/i;
var sensitiveKeyPattern2 = /(authorization|token|secret|password|cookie|email|invite|signature)/i;
var rawNavigationKeyPattern2 = /^(url|referrer|\$current_url|\$referrer)$/i;
var safeIdentifierKeys = /* @__PURE__ */ new Set(["account_id", "anonymous_id", "company_id", "distinct_id", "event_id", "group_id", "messageId", "user_id", "uuid", "workspace_id"]);
var safeBusinessKeys = /* @__PURE__ */ new Set(["feature_key", "is_key_feature", "metric_key", "product_key"]);
function objectValue2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function validationIssue({
  code,
  message,
  path,
  severity
}) {
  return { code, message, path, severity };
}
function normalizeSourcePayload(source, payload) {
  if (source === "posthog") return posthogToNormalized(payload);
  if (source === "segment") return segmentToNormalized(payload);
  return normalizeEventPayload(payload, "direct");
}
function directEventName(payload) {
  return nonEmptyString(payload.event_name) ?? nonEmptyString(payload.event) ?? nonEmptyString(payload.name) ?? nonEmptyString(payload.type);
}
function sourceEventName(source, payload) {
  if (source === "posthog") return posthogEventNameFromPayload(payload);
  if (source === "segment") return nonEmptyString(payload.event);
  return directEventName(payload);
}
function normalizeErrorCode(error) {
  if (error.includes("account_id or groupId")) return "missing_account_identity";
  if (error.includes(`event_name must be ${MAX_EVENT_NAME_LENGTH}`)) return "oversized_event_name";
  if (error.includes("more than 24 hours in the future")) return "future_timestamp";
  if (error.includes("emails or token-like secrets")) return "unsafe_event_name";
  return "normalization_error";
}
function collectSemanticCandidates(payload, source) {
  const records = [
    { path: "", record: payload },
    { path: "properties", record: objectValue2(payload.properties) }
  ];
  if (source === "posthog") {
    const wrappedEvent = objectValue2(payload.event);
    records.push({ path: "event", record: wrappedEvent });
    records.push({ path: "event.properties", record: objectValue2(wrappedEvent.properties) });
  }
  return records.flatMap(
    ({ path, record }) => ["semantic_type", "event_type"].flatMap((field) => {
      const value = nonEmptyString(record[field]);
      return value ? [{ path: path ? `${path}.${field}` : field, value }] : [];
    })
  );
}
function invalidSemanticTypeErrors(payload, source) {
  return collectSemanticCandidates(payload, source).filter(({ value }) => !semanticTypeSet.has(value)).map(
    ({ path, value }) => validationIssue({
      code: "invalid_semantic_type",
      message: `Invalid semantic type "${value}". Use one of: ${semanticEventTypes.join(", ")}.`,
      path,
      severity: "error"
    })
  );
}
function hasSuspiciousString(value) {
  return emailPattern2.test(value) || tokenLikePattern2.test(value);
}
function hasUrlQuery(value) {
  try {
    return new URL(value, value.startsWith("/") ? "https://app.local" : void 0).search.length > 0;
  } catch {
    return false;
  }
}
function isUnsafeKey(key2) {
  return !safeIdentifierKeys.has(key2) && !safeBusinessKeys.has(key2) && sensitiveKeyPattern2.test(key2);
}
function scanUnsafeFields(value, path = "", found = []) {
  if (found.length >= 25) return found;
  if (Array.isArray(value)) {
    value.slice(0, 50).forEach((item, index) => scanUnsafeFields(item, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && hasSuspiciousString(value)) {
      found.push(
        validationIssue({
          code: "unsafe_field",
          message: "Value contains an email or token-like secret and should not be sent to SaaSFunnels.",
          path,
          severity: "error"
        })
      );
    }
    return found;
  }
  for (const [key2, nestedValue] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key2}` : key2;
    if (isUnsafeKey(key2)) {
      found.push(
        validationIssue({
          code: "unsafe_field",
          message: `Field "${key2}" looks sensitive. Send bounded codes or safe metadata instead.`,
          path: nextPath,
          severity: "error"
        })
      );
    }
    if (rawNavigationKeyPattern2.test(key2) && typeof nestedValue === "string" && hasUrlQuery(nestedValue)) {
      found.push(
        validationIssue({
          code: "unsafe_field",
          message: "Full URLs with query strings should be omitted or reduced to safe path/UTM context.",
          path: nextPath,
          severity: "error"
        })
      );
    }
    scanUnsafeFields(nestedValue, nextPath, found);
  }
  return found;
}
function eventPreview(event) {
  return {
    account_id: event.account_id,
    event_kind: event.event_kind,
    event_name: event.event_name,
    idempotency_key: event.idempotency_key,
    properties: event.properties,
    semantic_type: event.semantic_type,
    source: event.source,
    source_event_id: event.source_event_id,
    timestamp: event.timestamp,
    user_id: event.user_id,
    value: event.value,
    workspace_id: event.workspace_id
  };
}
function mappingHints(event) {
  const unlock = signalUnlockContextForSemanticType(event?.semantic_type);
  return {
    event_kind: event?.event_kind,
    semantic_type: event?.semantic_type,
    signal_families: unlock?.families.map((family) => ({
      label: family.label,
      required: family.required,
      signal_family_key: family.signalFamilyKey
    })) ?? [],
    signal_unlock_summary: unlock?.summary
  };
}
function idempotencyGuidance(event) {
  if (event?.source_event_id) {
    return {
      guidance: "Source event id is present; retries should dedupe against the stable source id.",
      idempotency_key: event.idempotency_key,
      source_event_id: event.source_event_id,
      stable: true
    };
  }
  return {
    guidance: "Add event_id, messageId, uuid, or another deterministic source id for retryable completed events.",
    idempotency_key: event?.idempotency_key,
    stable: false
  };
}
function validateDeveloperToolEventPayload({
  payload,
  source
}) {
  const base = {
    errors: [],
    idempotency: idempotencyGuidance(),
    mapping_hints: { signal_families: [] },
    ok: false,
    redaction: {
      redacted_payload: redactPayload(payload),
      unsafe_field_count: 0,
      unsafe_field_paths: []
    },
    schema_version: DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
    source,
    warnings: []
  };
  const body = objectValue2(payload);
  if (!Object.keys(body).length) {
    base.errors.push(
      validationIssue({
        code: "invalid_payload",
        message: "Payload must be a non-empty JSON object.",
        severity: "error"
      })
    );
    return base;
  }
  const explicitEventName = sourceEventName(source, body);
  if (explicitEventName && explicitEventName.length > MAX_EVENT_NAME_LENGTH) {
    base.errors.push(
      validationIssue({
        code: "oversized_event_name",
        message: `event_name must be ${MAX_EVENT_NAME_LENGTH} characters or fewer.`,
        severity: "error"
      })
    );
  }
  base.errors.push(...invalidSemanticTypeErrors(body, source));
  const unsafeFields = scanUnsafeFields(body);
  base.errors.push(...unsafeFields);
  base.redaction = {
    redacted_payload: redactPayload(body),
    unsafe_field_count: unsafeFields.length,
    unsafe_field_paths: unsafeFields.flatMap((issue) => issue.path ? [issue.path] : [])
  };
  const normalized = normalizeSourcePayload(source, body);
  if (normalized.error) {
    base.errors.push(
      validationIssue({
        code: normalizeErrorCode(normalized.error),
        message: normalized.error,
        severity: "error"
      })
    );
  }
  if (normalized.event) {
    base.normalized_event = eventPreview(normalized.event);
    base.mapping_hints = mappingHints(normalized.event);
    base.idempotency = idempotencyGuidance(normalized.event);
    base.revenue_relevant = normalized.revenueRelevant;
    if (!normalized.event.source_event_id) {
      base.warnings.push(
        validationIssue({
          code: "missing_idempotency_key",
          message: base.idempotency.guidance,
          severity: "warning"
        })
      );
    }
    if (normalized.revenueRelevant === false) {
      base.warnings.push(
        validationIssue({
          code: "non_revenue_relevant_event",
          message: "This payload normalizes, but it does not look revenue-relevant enough for first-batch SaaSFunnels instrumentation.",
          severity: "warning"
        })
      );
    }
  }
  base.ok = base.errors.length === 0;
  return base;
}
function getDeveloperToolSourceContract(source) {
  if (source === "direct") {
    return {
      auth_summary: "Authorization: Bearer <SAASFUNNELS_INGEST_KEY>; workspace is resolved server-side from the scoped key.",
      docs_url: "/docs/integrations-and-sources/direct-api-installation",
      endpoint: "/api/events/ingest",
      key: "direct",
      name: "Direct API",
      recommended_allowlist: [
        "account_activated",
        "usage_limit_hit",
        "checkout_completed",
        "subscription_updated",
        "team_member_invited",
        "integration_configured"
      ],
      required_fields: [
        "event_name",
        "account_id",
        "timestamp",
        "recommended event_id for idempotency",
        "recommended account facts in properties.traits or properties"
      ],
      sample_payload: directApiSamplePayload(),
      scope: "direct:write",
      setup_steps: [
        "Create a Direct API ingest key in SaaSFunnels.",
        "Store the raw key in server-side environment variables only.",
        "Send account-scoped backend events to /api/events/ingest.",
        "Verify one smoke event in SaaSFunnels Direct API activity."
      ]
    };
  }
  const contract = inboundSourceContracts[source];
  return {
    auth_summary: contract.authSummary,
    docs_url: contract.docsUrl,
    endpoint: contract.endpoint,
    key: contract.key,
    name: contract.name,
    recommended_allowlist: contract.recommendedAllowlist,
    required_fields: contract.requiredFields,
    sample_payload: contract.samplePayload,
    scope: contract.scope,
    setup_steps: contract.setupSteps
  };
}
function getDeveloperToolAgentHandoffArtifacts({
  endpoint,
  eventPlan
}) {
  const handoff = getDirectApiAgentHandoff({ endpoint, eventPlan });
  return {
    "claude-code": {
      file_contents: handoff.tools["claude-code"].fileContents,
      install_command: handoff.tools["claude-code"].installCommand,
      label: handoff.tools["claude-code"].label,
      prompt: handoff.tools["claude-code"].prompt,
      target: "claude-code",
      target_path: handoff.tools["claude-code"].targetPath,
      version: handoff.version
    },
    codex: {
      file_contents: handoff.tools.codex.fileContents,
      install_command: handoff.tools.codex.installCommand,
      label: handoff.tools.codex.label,
      prompt: handoff.tools.codex.prompt,
      target: "codex",
      target_path: handoff.tools.codex.targetPath,
      version: handoff.version
    },
    cursor: {
      file_contents: handoff.tools.cursor.fileContents,
      install_command: handoff.tools.cursor.installCommand,
      label: handoff.tools.cursor.label,
      prompt: handoff.tools.cursor.prompt,
      target: "cursor",
      target_path: handoff.tools.cursor.targetPath,
      version: handoff.version
    },
    markdown: {
      file_contents: handoff.briefMarkdown,
      label: "Markdown",
      prompt: "Use this Direct API brief to implement the first safe SaaSFunnels backend events.",
      target: "markdown",
      target_path: "SAASFUNNELS_DIRECT_API.md",
      version: handoff.version
    }
  };
}

import { z as z2 } from "zod";

import { z } from "zod";
var FUNNEL_FEATURE_CATALOG_SCHEMA_VERSION = 2;
var funnelFeatureEnvironments = ["test", "production"];
var funnelFeatureAccessModels = ["boolean", "limit"];
var funnelFeatureKinds = ["capability", "quota"];
var funnelFeatureQuotaPeriods = [
  "instantaneous",
  "billing_period",
  "calendar_month",
  "lifetime"
];
var funnelFeatureQuotaAggregations = ["current", "sum", "maximum"];
var funnelFeatureUsageSources = ["customer_reported"];
var funnelFeatureCatalogStates = ["draft", "published", "retired"];
var funnelFeatureLifecycleStates = ["active", "archived"];
var funnelFeatureEvidenceSources = [
  "manual",
  "stripe_marketing_feature",
  "stripe_metadata",
  "stripe_entitlements_feature",
  "approved_customer_manifest",
  "repository_discovery"
];
var funnelFeatureEntitlementSources = [
  "temporary_grant",
  "price_override",
  "plan_default",
  "default_deny"
];
var funnelFeatureEntitlementReasonCodes = [
  "ALLOWED_TEMPORARY_GRANT",
  "DENIED_TEMPORARY_GRANT",
  "ALLOWED_PRICE_OVERRIDE",
  "ALLOWED_PLAN_DEFAULT",
  "DENIED_PRICE_OVERRIDE",
  "DENIED_PLAN_DEFAULT",
  "DENIED_DEFAULT",
  "ACCOUNT_UNVERIFIED",
  "SUBSCRIPTION_MISSING",
  "BILLING_CUSTOMER_MISSING",
  "SUBSCRIPTION_INELIGIBLE",
  "SUBSCRIPTION_AMBIGUOUS",
  "SUBSCRIPTION_STALE",
  "PLAN_MAPPING_MISSING",
  "PRICE_MAPPING_MISSING",
  "FEATURE_NOT_FOUND",
  "USAGE_MISSING",
  "USAGE_STALE",
  "LIMIT_REACHED",
  "ENVIRONMENT_MISMATCH",
  "CONFIGURATION_UNAVAILABLE",
  "ENTITLEMENT_UNAVAILABLE",
  "IDENTITY_MISMATCH",
  "WORKSPACE_MISMATCH"
];
var funnelFeatureGrantSources = ["manual", "funnel", "api"];
var funnelFeatureBindingKinds = [
  "server_enforcement",
  "browser_presentation",
  "usage_reporter",
  "funnel_trigger",
  "discovery"
];
var funnelFeatureBindingStates = [
  "suggested",
  "confirmed",
  "stale",
  "removed"
];
var boundedKey = z.string().min(1).max(80).regex(/^[a-z][a-z0-9_.-]*$/);
var fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
var timestamp = z.string().datetime({ offset: true });
var uuid = z.string().uuid();
var exactReference = (kind) => z.object({
  entityKey: boundedKey,
  entityKind: z.literal(kind),
  version: z.number().int().min(1)
}).strict();
var funnelFeatureValueSchema = z.discriminatedUnion("kind", [
  z.object({ allowed: z.boolean(), kind: z.literal("boolean") }).strict(),
  z.object({
    kind: z.literal("limit"),
    limit: z.number().min(0).nullable(),
    unlimited: z.boolean()
  }).strict().superRefine((value, context) => {
    if (value.unlimited !== (value.limit === null)) {
      context.addIssue({
        code: "custom",
        message: "Unlimited feature limits use a null numeric limit.",
        path: ["limit"]
      });
    }
  })
]);
var funnelFeatureEvidenceSchema = z.object({
  confidenceBasisPoints: z.number().int().min(0).max(1e4),
  fingerprint,
  label: z.string().min(1).max(240),
  observedAt: timestamp,
  source: z.enum(funnelFeatureEvidenceSources)
}).strict();
var funnelFeatureQuotaSchema = z.object({
  aggregation: z.enum(funnelFeatureQuotaAggregations),
  period: z.enum(funnelFeatureQuotaPeriods),
  unit: z.string().min(1).max(80),
  usageSource: z.enum(funnelFeatureUsageSources)
}).strict();
var funnelFeatureDefinitionSchema = z.object({
  accessModel: z.enum(funnelFeatureAccessModels),
  aliases: z.array(boundedKey).max(50),
  description: z.string().max(4e3),
  evidence: z.array(funnelFeatureEvidenceSchema).max(16),
  featureKey: boundedKey,
  featureKind: z.enum(funnelFeatureKinds),
  lifecycleState: z.enum(funnelFeatureLifecycleStates),
  name: z.string().min(1).max(240),
  quota: funnelFeatureQuotaSchema.nullable()
}).strict().superRefine((feature, context) => {
  if (feature.featureKind === "quota" !== (feature.accessModel === "limit" && feature.quota !== null) || feature.featureKind === "capability" && (feature.accessModel !== "boolean" || feature.quota !== null)) {
    context.addIssue({
      code: "custom",
      message: "Capabilities use on/off access; quotas require complete measurement semantics.",
      path: ["featureKind"]
    });
  }
  if (feature.aliases.includes(feature.featureKey)) {
    context.addIssue({
      code: "custom",
      message: "A feature key cannot also be one of its aliases.",
      path: ["aliases"]
    });
  }
  if (new Set(feature.aliases).size !== feature.aliases.length) {
    context.addIssue({
      code: "custom",
      message: "Feature aliases must be unique.",
      path: ["aliases"]
    });
  }
});
var funnelPlanFeatureRuleSchema = z.object({
  featureKey: boundedKey,
  planRef: exactReference("plan"),
  value: funnelFeatureValueSchema
}).strict();
var funnelPriceFeatureOverrideSchema = z.object({
  featureKey: boundedKey,
  planRef: exactReference("plan"),
  priceRef: exactReference("price"),
  value: funnelFeatureValueSchema
}).strict();
var funnelFeatureCatalogVersionSchema = z.object({
  catalogFingerprint: fingerprint,
  createdAt: timestamp,
  createdBy: z.string().min(1).max(160),
  definitions: z.array(funnelFeatureDefinitionSchema).max(5e3),
  environment: z.enum(funnelFeatureEnvironments),
  integrationId: uuid,
  planRules: z.array(funnelPlanFeatureRuleSchema).max(5e4),
  priceOverrides: z.array(funnelPriceFeatureOverrideSchema).max(5e4),
  publishedAt: timestamp.nullable(),
  publishedBy: z.string().min(1).max(160).nullable(),
  retiredAt: timestamp.nullable(),
  retiredBy: z.string().min(1).max(160).nullable(),
  schemaVersion: z.literal(FUNNEL_FEATURE_CATALOG_SCHEMA_VERSION),
  state: z.enum(funnelFeatureCatalogStates),
  version: z.number().int().min(1),
  workspaceId: uuid
}).strict().superRefine((catalog, context) => {
  const published = catalog.state === "published" || catalog.state === "retired";
  if (published !== Boolean(catalog.publishedAt && catalog.publishedBy)) {
    context.addIssue({
      code: "custom",
      message: "Published feature catalogs require publication provenance.",
      path: ["publishedAt"]
    });
  }
  if (catalog.state === "retired" !== Boolean(catalog.retiredAt && catalog.retiredBy)) {
    context.addIssue({
      code: "custom",
      message: "Only retired feature catalogs declare retirement provenance.",
      path: ["retiredAt"]
    });
  }
  const definitionByKey = new Map(
    catalog.definitions.map((definition) => [definition.featureKey, definition])
  );
  if (definitionByKey.size !== catalog.definitions.length) {
    context.addIssue({
      code: "custom",
      message: "Feature keys must be unique within a catalog version.",
      path: ["definitions"]
    });
  }
  const aliases = catalog.definitions.flatMap((definition) => [
    definition.featureKey,
    ...definition.aliases
  ]);
  if (new Set(aliases).size !== aliases.length) {
    context.addIssue({
      code: "custom",
      message: "Feature keys and aliases cannot resolve to more than one feature.",
      path: ["definitions"]
    });
  }
  const planRuleKeys = /* @__PURE__ */ new Set();
  catalog.planRules.forEach((rule, index) => {
    const definition = definitionByKey.get(rule.featureKey);
    if (!definition) {
      context.addIssue({
        code: "custom",
        message: `Plan rule feature "${rule.featureKey}" is missing.`,
        path: ["planRules", index, "featureKey"]
      });
    } else {
      if (definition.lifecycleState !== "active") {
        context.addIssue({
          code: "custom",
          message: "Archived features cannot be assigned to a plan.",
          path: ["planRules", index, "featureKey"]
        });
      }
      if (definition.accessModel !== rule.value.kind) {
        context.addIssue({
          code: "custom",
          message: "Plan rule values must match the feature access model.",
          path: ["planRules", index, "value"]
        });
      }
    }
    const ruleKey = `${rule.planRef.entityKey}:${rule.planRef.version}:${rule.featureKey}`;
    if (planRuleKeys.has(ruleKey)) {
      context.addIssue({
        code: "custom",
        message: "A plan can declare only one default for a feature.",
        path: ["planRules", index]
      });
    }
    planRuleKeys.add(ruleKey);
  });
  const priceOverrideKeys = /* @__PURE__ */ new Set();
  catalog.priceOverrides.forEach((override, index) => {
    const definition = definitionByKey.get(override.featureKey);
    if (!definition) {
      context.addIssue({
        code: "custom",
        message: `Price override feature "${override.featureKey}" is missing.`,
        path: ["priceOverrides", index, "featureKey"]
      });
    } else if (definition.accessModel !== override.value.kind) {
      context.addIssue({
        code: "custom",
        message: "Price override values must match the feature access model.",
        path: ["priceOverrides", index, "value"]
      });
    }
    const planRuleKey = `${override.planRef.entityKey}:${override.planRef.version}:${override.featureKey}`;
    if (!planRuleKeys.has(planRuleKey)) {
      context.addIssue({
        code: "custom",
        message: "A price override requires an existing plan default for the same feature.",
        path: ["priceOverrides", index, "planRef"]
      });
    }
    const overrideKey = `${override.priceRef.entityKey}:${override.priceRef.version}:${override.featureKey}`;
    if (priceOverrideKeys.has(overrideKey)) {
      context.addIssue({
        code: "custom",
        message: "A price can declare only one override for a feature.",
        path: ["priceOverrides", index]
      });
    }
    priceOverrideKeys.add(overrideKey);
  });
});
var funnelFeatureUsageSnapshotSchema = z.object({
  accountId: uuid,
  environment: z.enum(funnelFeatureEnvironments),
  featureKey: boundedKey,
  idempotencyKey: z.string().min(8).max(160),
  observedAt: timestamp,
  periodEnd: timestamp,
  periodStart: timestamp,
  value: z.number().min(0),
  workspaceId: uuid
}).strict().superRefine((snapshot, context) => {
  if (Date.parse(snapshot.periodEnd) <= Date.parse(snapshot.periodStart)) {
    context.addIssue({ code: "custom", message: "Usage periods must end after they start.", path: ["periodEnd"] });
  }
  if (Date.parse(snapshot.observedAt) < Date.parse(snapshot.periodStart)) {
    context.addIssue({
      code: "custom",
      message: "Usage cannot be observed before its reporting period begins.",
      path: ["observedAt"]
    });
  }
});
var funnelTemporaryFeatureGrantSchema = z.object({
  accountId: uuid,
  createdAt: timestamp,
  createdBy: z.string().min(1).max(160),
  environment: z.enum(funnelFeatureEnvironments),
  expiresAt: timestamp,
  featureKey: boundedKey,
  grantId: uuid,
  reason: z.string().min(1).max(1e3),
  revokedAt: timestamp.nullable(),
  revokedBy: z.string().min(1).max(160).nullable(),
  revocationReason: z.string().min(1).max(1e3).nullable(),
  source: z.enum(funnelFeatureGrantSources),
  startsAt: timestamp,
  value: funnelFeatureValueSchema,
  workspaceId: uuid
}).strict().superRefine((grant, context) => {
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.startsAt)) {
    context.addIssue({ code: "custom", message: "Temporary grants must expire after they start.", path: ["expiresAt"] });
  }
  if (grant.revokedAt !== null !== Boolean(grant.revokedBy && grant.revocationReason)) {
    context.addIssue({
      code: "custom",
      message: "Grant revocation requires time, actor, and reason together.",
      path: ["revokedAt"]
    });
  }
});
var funnelFeatureDecisionSchema = z.object({
  accountId: uuid,
  allowed: z.boolean(),
  catalogVersion: z.number().int().min(1).nullable(),
  decisionId: uuid,
  environment: z.enum(funnelFeatureEnvironments),
  evaluatedAt: timestamp,
  expiresAt: timestamp,
  featureKey: boundedKey,
  reasonCode: z.enum(funnelFeatureEntitlementReasonCodes),
  source: z.enum(funnelFeatureEntitlementSources),
  usage: z.object({
    current: z.number().min(0),
    periodEnd: timestamp,
    periodStart: timestamp,
    remaining: z.number().min(0).nullable()
  }).strict().nullable(),
  value: funnelFeatureValueSchema.nullable(),
  workspaceId: uuid
}).strict().superRefine((decision, context) => {
  if (Date.parse(decision.expiresAt) <= Date.parse(decision.evaluatedAt)) {
    context.addIssue({ code: "custom", message: "Feature decisions must expire after evaluation.", path: ["expiresAt"] });
  }
  if (decision.allowed && decision.value === null) {
    context.addIssue({
      code: "custom",
      message: "Allowed decisions require an effective feature value.",
      path: ["value"]
    });
  }
  if (decision.allowed && decision.value?.kind === "limit" && !decision.value.unlimited && decision.usage === null) {
    context.addIssue({
      code: "custom",
      message: "Allowed finite limits require usage context.",
      path: ["usage"]
    });
  }
});
var funnelFeatureBindingEvidenceSchema = z.object({
  bindingKind: z.enum(funnelFeatureBindingKinds),
  evidenceFingerprint: fingerprint,
  featureKey: boundedKey,
  manifestVersion: z.string().min(1).max(80),
  observedAt: timestamp,
  repositoryPath: z.string().min(1).max(1024),
  repositoryRevision: z.string().min(1).max(160),
  state: z.enum(funnelFeatureBindingStates),
  symbol: z.string().min(1).max(240).nullable()
}).strict();

var key = z2.string().min(1).max(80).regex(/^[a-z][a-z0-9_.-]*$/);
var fingerprint2 = z2.string().regex(/^[0-9a-f]{64}$/);
var timestamp2 = z2.string().datetime({ offset: true });
var featureInstrumentationBindingSchema = z2.object({
  bindingIdentityFingerprint: fingerprint2,
  bindingKind: z2.enum(funnelFeatureBindingKinds),
  evidenceFingerprint: fingerprint2,
  featureKey: key,
  line: z2.number().int().min(1).max(1e7),
  repositoryPath: z2.string().min(1).max(1024).refine(
    (value) => !value.startsWith("/") && !value.includes("..") && !/(^|\/)(\.env|secrets?|credentials?|private[-_.]?keys?)(\.|\/|$)/i.test(
      value
    ),
    "Repository paths must be relative and non-sensitive."
  ),
  symbol: z2.string().min(1).max(240)
}).strict();
var featureInstrumentationManifestProducers = ["cli", "github_action", "github_app"];
var featureInstrumentationScanRoles = ["series", "candidate"];
var featureInstrumentationManifestSchema = z2.object({
  bindings: z2.array(featureInstrumentationBindingSchema).max(1e4),
  discoveryRoots: z2.array(
    z2.string().min(1).max(200).refine(
      (value) => !value.startsWith("/") && !value.includes(".."),
      "Discovery roots must be relative and contained."
    )
  ).max(50),
  environment: z2.enum(funnelFeatureEnvironments),
  manifestFingerprint: fingerprint2,
  manifestVersion: z2.string().min(1).max(80),
  producer: z2.enum(featureInstrumentationManifestProducers),
  repositoryKey: z2.string().min(1).max(200),
  repositoryRevision: z2.string().min(1).max(160),
  scanRole: z2.enum(featureInstrumentationScanRoles),
  schemaVersion: z2.literal(2),
  sdkVersions: z2.array(z2.string().max(40).regex(/^\d+\.\d+\.\d+$/)).max(10).default([]),
  validatedAt: timestamp2,
  validationState: z2.enum(["valid", "failed"])
}).strict().superRefine((manifest, context) => {
  const fingerprints = manifest.bindings.map(
    (binding) => binding.evidenceFingerprint
  );
  if (new Set(fingerprints).size !== fingerprints.length) {
    context.addIssue({
      code: "custom",
      message: "Binding evidence fingerprints must be unique.",
      path: ["bindings"]
    });
  }
});
export {
  featureInstrumentationManifestProducers,
  featureInstrumentationScanRoles,
  DEVELOPER_TOOLS_CONTRACT_SCHEMA_VERSION,
  developerToolEventSources,
  eventKinds,
  eventSentimentSources,
  eventSentiments,
  featureInstrumentationManifestSchema,
  getDeveloperToolAgentHandoffArtifacts,
  getDeveloperToolSourceContract,
  semanticEventTypes,
  signalFamilyContracts,
  validateDeveloperToolEventPayload
};

