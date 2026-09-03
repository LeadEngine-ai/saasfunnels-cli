/**
 * Renders a drift response as a GitHub check summary.
 *
 * Lives in the CLI package rather than the Action because this is the only part
 * of the Action carrying logic worth testing; the Action itself is a thin
 * wrapper around `features handoff` plus this formatter.
 */

export type FeatureDriftEntry = {
  featureKey: string | null;
  kind: "added" | "moved" | "removed" | "renamed";
  location: string | null;
};

export type FeatureDriftRejection = {
  featureKey: string | null;
  reason: string;
};

const kindHeadings: Record<FeatureDriftEntry["kind"], string> = {
  added: "New Feature bindings",
  moved: "Moved bindings",
  removed: "Removed bindings",
  renamed: "Renamed bindings",
};

const rejectionReasons: Record<string, string> = {
  binding_duplicate: "duplicate evidence for one location",
  binding_fingerprint_invalid: "malformed fingerprint",
  binding_kind_unknown: "unrecognised binding kind",
  binding_path_unsafe: "unsafe or sensitive file path",
  binding_shape_invalid: "malformed binding",
};

export function formatFeatureDriftCheckSummary(input: {
  drift: FeatureDriftEntry[];
  proposedFeatureKeys?: string[];
  rejectedBindings?: FeatureDriftRejection[];
  targetedFeatureKeys?: string[];
}) {
  const lines: string[] = [];
  const removed = input.drift.filter((entry) => entry.kind === "removed");

  // The whole point of the pre-merge check: a removed binding whose Feature a
  // published Funnel still targets breaks that Funnel silently after merge.
  const breaking = removed.filter(
    (entry) =>
      entry.featureKey &&
      (input.targetedFeatureKeys ?? []).includes(entry.featureKey),
  );
  if (breaking.length) {
    lines.push("### Live Funnels target Features this change removes");
    for (const entry of breaking) {
      lines.push(`- \`${entry.featureKey}\`${entry.location ? ` — ${entry.location}` : ""}`);
    }
    lines.push("");
  }

  if (!input.drift.length) {
    lines.push("No Feature binding changes.");
  } else {
    for (const kind of ["removed", "renamed", "moved", "added"] as const) {
      const entries = input.drift.filter((entry) => entry.kind === kind);
      if (!entries.length) continue;
      lines.push(`### ${kindHeadings[kind]}`);
      for (const entry of entries) {
        lines.push(
          `- \`${entry.featureKey ?? "unknown"}\`${entry.location ? ` — ${entry.location}` : ""}`,
        );
      }
      lines.push("");
    }
  }

  if (input.proposedFeatureKeys?.length) {
    lines.push("### Found in code, not in your catalog");
    for (const featureKey of input.proposedFeatureKeys) {
      lines.push(`- \`${featureKey}\``);
    }
    lines.push("");
  }

  if (input.rejectedBindings?.length) {
    lines.push("### Evidence that could not be recorded");
    for (const rejection of input.rejectedBindings) {
      lines.push(
        `- \`${rejection.featureKey ?? "unknown"}\` — ${rejectionReasons[rejection.reason] ?? rejection.reason}`,
      );
    }
    lines.push("");
  }

  return {
    // Never fail the build: a false positive blocking a merge queue is the
    // fastest way to get uninstalled.
    conclusion: "neutral" as const,
    summary: lines.join("\n").trim(),
    title: breaking.length
      ? `${breaking.length} Feature${breaking.length === 1 ? "" : "s"} targeted by live Funnels removed`
      : input.drift.length
        ? `${input.drift.length} Feature binding change${input.drift.length === 1 ? "" : "s"}`
        : "No Feature binding changes",
  };
}
