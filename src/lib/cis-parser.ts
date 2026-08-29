import "server-only";
import type { CisTest } from "./types";

/**
 * Typed error thrown by parseCisContent when template content doesn't match
 * the CisTest[] shape (plan §3). `issues` lists every rule that failed
 * validation and why, so bad data is diagnosable without re-running.
 */
export class CisContentError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `CIS template content is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n` +
        issues.join("\n"),
    );
    this.name = "CisContentError";
    this.issues = issues;
  }
}

/**
 * Server-side parser helper (plan §7a, build prompt 11).
 *
 * This is the app's ONE AND ONLY schema validation point for CIS data —
 * nothing upstream (insertion, editing) validates anything, so this must
 * reject anything that doesn't match the CisTest[] shape from §3: missing
 * fields, wrong types, or a `check` object that doesn't match one of the
 * six known CheckType variants. It throws a typed CisContentError listing
 * every offending rule. Valid content is filtered to `automated: true`
 * (and manual-check rules are excluded entirely per §7a — manual rules are
 * never executed by the scanner, keeping the score's meaning consistent:
 * every counted rule was mechanically checked).
 *
 * Generic on purpose: it depends only on the CisTest shape, not on the
 * content of any particular benchmark file.
 */

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `${typeof value} (${JSON.stringify(value)?.slice(0, 60)})`;
}

function issue(index: number, ruleId: unknown, problem: string): string {
  const id = typeof ruleId === "string" ? ruleId : "<missing rule_id>";
  return `  rule #${index} (${id}): ${problem}`;
}

/**
 * Validates the `check` object against the six known CheckType variants.
 * The `type` discriminant must be one of the six and its payload field must
 * be present with the right type.
 */
function checkIssue(check: unknown): string | null {
  if (check === null || typeof check !== "object" || Array.isArray(check)) {
    return `check must be an object with a known "type", got ${describe(check)}`;
  }
  const c = check as Record<string, unknown>;
  switch (c.type) {
    case "output_empty":
    case "manual":
      return null;
    case "output_contains":
    case "output_equals":
      return typeof c.value === "string"
        ? null
        : `check.type "${String(c.type)}" requires a string "value"`;
    case "output_matches_regex":
      return typeof c.pattern === "string"
        ? null
        : 'check.type "output_matches_regex" requires a string "pattern"';
    case "numeric_gte":
      return typeof c.value === "number" && Number.isFinite(c.value)
        ? null
        : 'check.type "numeric_gte" requires a finite number "value"';
    default:
      return `unknown check.type ${describe(c.type)} — must be one of: output_empty, output_contains, output_equals, output_matches_regex, numeric_gte, manual`;
  }
}

function ruleIssues(rule: unknown, index: number): string[] {
  const problems: string[] = [];
  const r = (rule && typeof rule === "object" ? rule : {}) as Record<string, unknown>;

  if (typeof r.rule_id !== "string") problems.push(`rule_id must be a string, got ${describe(r.rule_id)}`);
  if (typeof r.number !== "string") problems.push(`number must be a string, got ${describe(r.number)}`);
  if (typeof r.severity !== "string") problems.push(`severity must be a string, got ${describe(r.severity)}`);
  if (typeof r.automated !== "boolean") problems.push(`automated must be a boolean, got ${describe(r.automated)}`);
  if (typeof r.title !== "string") problems.push(`title must be a string, got ${describe(r.title)}`);
  if (r.cci !== undefined && typeof r.cci !== "string") problems.push(`cci must be a string when present, got ${describe(r.cci)}`);
  if (
    !Array.isArray(r.audit_command) ||
    r.audit_command.length === 0 ||
    !r.audit_command.every((cmd) => typeof cmd === "string")
  ) {
    problems.push("audit_command must be a non-empty array of strings");
  }
  if (typeof r.audit_procedure !== "string") {
    problems.push(`audit_procedure must be a string, got ${describe(r.audit_procedure)}`);
  }
  if (typeof r.remediation !== "string") problems.push(`remediation must be a string, got ${describe(r.remediation)}`);

  const checkProblem = checkIssue(r.check);
  if (checkProblem) problems.push(checkProblem);

  return problems.map((p) => issue(index, r.rule_id, p));
}

/**
 * Parses and validates template content. Throws CisContentError on ANY
 * invalid rule (validation is all-or-nothing — a template is either fully
 * well-formed or rejected; partially scanning unvetted data is exactly the
 * failure mode an audit tool must avoid).
 */
export function parseCisContent(json: unknown): CisTest[] {
  if (!Array.isArray(json)) {
    throw new CisContentError([
      `content must be a JSON array of CisTest rules, got ${describe(json)}`,
    ]);
  }

  const issues: string[] = [];
  json.forEach((rule, index) => {
    issues.push(...ruleIssues(rule, index));
  });
  if (issues.length > 0) {
    throw new CisContentError(issues);
  }

  console.log(`[parseCisContent] validated ${json.length} rules, filtering to automated-only...`);

  // Shape is fully valid — now filter to what the scanner may execute.
  const automatedRules = (json as CisTest[]).filter(
    (rule) => rule.automated && rule.check.type !== "manual",
  );
  console.log(`[parseCisContent] filtered to ${automatedRules.length} automated rules.`);
  return automatedRules;
}
