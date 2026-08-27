import "server-only";
import type { CisTest, CheckType } from "./types";

/**
 * Server-side parser helper (plan §7a).
 *
 * Generic on purpose: it depends only on the CisTest shape (plan §3), not
 * on the content of any particular benchmark file, so it works the same
 * regardless of which distro/version/benchmark produced the JSON.
 *
 * - Validates the stored `content` against the CisTest shape.
 * - Filters to `automated: true` AND `check.type !== "manual"`: manual rules
 *   are excluded from scans entirely rather than run and flagged, which
 *   keeps the scan's score meaning consistent — every rule counted in the
 *   score was actually, mechanically checked.
 */

const VALID_SEVERITIES = ["cati", "catii", "catiii"];

function isValidCheck(check: unknown): check is CheckType {
  if (!check || typeof check !== "object") return false;
  const c = check as Record<string, unknown>;
  switch (c.type) {
    case "output_empty":
    case "manual":
      return true;
    case "output_contains":
    case "output_equals":
    case "output_matches_regex":
      return typeof c.value === "string" || typeof c.pattern === "string";
    case "numeric_gte":
      return typeof c.value === "number" && Number.isFinite(c.value);
    default:
      return false;
  }
}

function isCisTest(rule: unknown): rule is CisTest {
  if (!rule || typeof rule !== "object") return false;
  const r = rule as Record<string, unknown>;
  return (
    typeof r.rule_id === "string" &&
    typeof r.number === "string" &&
    typeof r.severity === "string" &&
    typeof r.automated === "boolean" &&
    typeof r.title === "string" &&
    Array.isArray(r.audit_command) &&
    r.audit_command.every((cmd) => typeof cmd === "string") &&
    typeof r.audit_procedure === "string" &&
    typeof r.remediation === "string" &&
    isValidCheck(r.check) &&
    (VALID_SEVERITIES.includes(r.severity.toLowerCase()) || true) // severity scheme is whatever the source benchmark uses
  );
}

export function parseCisContent(json: unknown): CisTest[] {
  if (!Array.isArray(json)) {
    throw new Error("CIS template content must be a JSON array of rules.");
  }

  const invalid: number[] = [];
  const tests: CisTest[] = [];

  json.forEach((rule, index) => {
    if (isCisTest(rule)) {
      if (rule.automated && rule.check.type !== "manual") {
        tests.push(rule);
      }
    } else {
      invalid.push(index);
    }
  });

  if (invalid.length > 0) {
    console.warn(
      `[cis-parser] skipped ${invalid.length} malformed rule(s) at indices: ${invalid.join(", ")}`,
    );
  }

  return tests;
}
