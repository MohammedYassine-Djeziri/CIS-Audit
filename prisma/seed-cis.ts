/**
 * CIS/STIG benchmark seed script (plan § build prompt 4).
 *
 * Ingests any correctly-shaped CIS/STIG benchmark JSON (any distro, any
 * version) and inserts it as one CisTemplate row, adding a `check` field
 * (plan §3) to every rule. The `check` type is inferred from each rule's
 * audit text; rules where the right check type is ambiguous from the audit
 * text alone are marked `{ type: "manual" }` and reported for review — a
 * wrong `check` silently produces a wrong pass/fail result, so nothing is
 * guessed at.
 *
 * Usage:
 *   npx tsx prisma/seed-cis.ts <benchmark.json> [--name "CIS Ubuntu 24.04 Benchmark"]
 *                              [--checks overrides.json]
 *
 * - Re-running with a new source file (and a new --name) seeds additional
 *   templates; re-running with the same --name updates that template.
 * - `--checks overrides.json` (optional) maps rule_id -> CheckType for rules
 *   that were flagged for review and then decided by hand, e.g.:
 *   { "UBTU-24-300025": { "type": "output_equals", "value": "@as []" } }
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";
import type { CisTest, CheckType } from "../src/lib/types";

const prisma = new PrismaClient();

interface RawRule {
  rule_id?: unknown;
  number?: unknown;
  severity?: unknown;
  automated?: unknown;
  title?: unknown;
  cci?: unknown;
  audit_command?: unknown;
  audit_procedure?: unknown;
  remediation?: unknown;
  check?: unknown;
}

interface Inferred {
  check: CheckType;
  rationale: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All of the pattern matching below runs against lowercase text. */
function inferCheck(rule: RawRule): Inferred | null {
  const title = String(rule.title ?? "").toLowerCase();
  const procedure = String(rule.audit_procedure ?? "").toLowerCase();
  const commands = (Array.isArray(rule.audit_command) ? rule.audit_command : [])
    .map(String)
    .join(" ; ")
    .toLowerCase();
  const text = `${title} ${procedure}`;

  // --- numeric thresholds ("less than N", "N or higher") ------------------
  // e.g. 'If "PASS_MIN_DAYS" is less than "1" ... this is a finding'
  //      'If "minlen" is not "15" or higher ... this is a finding'
  const lessThan = procedure.match(/is less than "?(?<n>\d+)"?/);
  if (lessThan?.groups) {
    return {
      check: { type: "numeric_gte", value: Number(lessThan.groups.n) },
      rationale: `audit text says "less than ${lessThan.groups.n}" is a finding`,
    };
  }
  const orHigher = procedure.match(/is not "?(?<n>\d+)"? or higher/);
  if (orHigher?.groups) {
    return {
      check: { type: "numeric_gte", value: Number(orHigher.groups.n) },
      rationale: `audit text says "${orHigher.groups.n} or higher" is required`,
    };
  }

  // --- exact expected output ("a value of X is not returned") -------------
  // e.g. FIPS: 'If a value of "1" is not returned, this is a finding.'
  const exactValue = procedure.match(/a value of "(?<v>[^"]+)" is not returned/);
  if (exactValue?.groups) {
    return {
      check: { type: "output_equals", value: exactValue.groups.v.trim() },
      rationale: `audit text says a value of "${exactValue.groups.v}" must be returned`,
    };
  }

  // --- package must NOT be installed --------------------------------------
  // e.g. 'If the "rsh-server" package is installed, this is a finding.'
  if (
    /package is installed, this is a finding/.test(procedure) ||
    (/must not have .* installed/.test(text) && commands.includes("dpkg"))
  ) {
    return {
      check: { type: "output_empty" },
      rationale: "package must not be installed — any grep output is a finding",
    };
  }

  // --- package must be installed ------------------------------------------
  // e.g. 'If "vlock" is not installed, this is a finding.'
  // dpkg -l output lines for installed packages start with "ii".
  if (/is not installed, this is a finding/.test(procedure) && commands.includes("dpkg")) {
    return {
      check: { type: "output_matches_regex", pattern: "^ii\\s" },
      rationale: "package must be installed — dpkg -l line must start with 'ii'",
    };
  }

  // --- systemd service must be enabled AND active -------------------------
  // e.g. 'If "auditd.service" is not enabled and active, this is a finding.'
  if (
    (/is not enabled and active/.test(procedure) || /is not active or enabled/.test(procedure)) &&
    commands.includes("is-enabled") &&
    commands.includes("is-active")
  ) {
    return {
      check: { type: "output_matches_regex", pattern: "enabled[\\s\\S]*active" },
      rationale: "service must be both enabled (is-enabled) and active (is-active)",
    };
  }

  // --- systemd unit must be masked ----------------------------------------
  // e.g. 'If the "ctrl-alt-del.target" is not masked, this is a finding.'
  if (/is not masked/.test(procedure)) {
    return {
      check: { type: "output_contains", value: "masked" },
      rationale: "unit must be masked — status output must contain 'masked'",
    };
  }

  // --- file/dir must be (group-)owned by X --------------------------------
  // e.g. 'If the "/var/log" directory is not owned by "root", this is a finding.'
  // Only applies to `stat`-style commands (find ! -user variants are handled
  // by the negative-find matcher below).
  const ownedBy = procedure.match(/is not (?:group-)?owned by "(?<owner>[^"]+)"/);
  if (ownedBy?.groups && commands.includes("stat") && !/! -(user|group|perm)/.test(commands)) {
    return {
      check: { type: "output_contains", value: ownedBy.groups.owner },
      rationale: `stat output must contain owner/group "${ownedBy.groups.owner}"`,
    };
  }

  // --- negative find / "any output is a finding" --------------------------
  // e.g. 'find /bin ... ! -user root' + 'If any ... are returned, this is a finding'
  if (
    /!\s*-(user|group|perm)/.test(commands) ||
    /(if any|are returned, this is a finding|returns any results|produces any output|occurrences of)/.test(
      procedure,
    )
  ) {
    return {
      check: { type: "output_empty" },
      rationale: "audit text says any command output is a finding",
    };
  }

  // --- config key must be set to a value ("is set to X ... finding") ------
  // e.g. 'If "X11Forwarding" is set to "yes" ... this is a finding.' The
  // expected value ("no") is taken from the remediation line for that key.
  const setTo = procedure.match(/"(?<key>[a-z0-9_]+)" is set to "(?<bad>yes|no|on|off|1|0)"/);
  if (setTo?.groups) {
    const expected = String(rule.remediation ?? "")
      .toLowerCase()
      .match(new RegExp(`${setTo.groups.key}\\s+([a-z0-9_]+)`));
    if (expected && expected[1] !== setTo.groups.bad) {
      return {
        check: {
          type: "output_matches_regex",
          pattern: `${setTo.groups.key}\\s+${expected[1]}`,
        },
        rationale: `"${setTo.groups.key}" must be "${expected[1]}" (from remediation), not "${setTo.groups.bad}"`,
      };
    }
  }

  // --- multiple keys must all be set to a value ---------------------------
  // e.g. 'If "PermitEmptyPasswords" and "PermitUserEnvironment" are not set
  //       to "no", ... this is a finding.'
  const multiSet = procedure.match(
    /"(?<keys>[a-z0-9_]+"(?:\s*(?:,|and)\s*"[a-z0-9_]+)+)"\s+are not set to "(?<value>[a-z0-9_]+)"/,
  );
  if (multiSet?.groups) {
    const keys = [...multiSet.groups.keys.matchAll(/[a-z0-9_]+/g)].map((m) => m[0]);
    const pattern =
      keys.map((k) => `(?=[\\s\\S]*${k}\\s+${multiSet.groups!.value})`).join("") + "[\\s\\S]*";
    return {
      check: { type: "output_matches_regex", pattern },
      rationale: `all of [${keys.join(", ")}] must be set to "${multiSet.groups.value}"`,
    };
  }

  // --- output must contain a specific token -------------------------------
  // 'If the root password entry does not begin with "password_pbkdf2" ...'
  // 'If the output does not contain "L" in the second field ...'
  // '... adding the "-e 2" option ... this is a finding.'
  const beginsWith = procedure.match(/does not begin with "(?<v>[^"]+)"/);
  if (beginsWith?.groups) {
    return {
      check: { type: "output_contains", value: beginsWith.groups.v },
      rationale: `output must contain "${beginsWith.groups.v}"`,
    };
  }
  const containsToken = procedure.match(/does not contain "(?<v>[^"]+)" in the second field/);
  if (containsToken?.groups) {
    return {
      check: {
        type: "output_matches_regex",
        pattern: `(^|\\s)${escapeRegex(containsToken.groups.v)}(\\s|$)`,
      },
      rationale: `"${containsToken.groups.v}" must appear as its own field in the output`,
    };
  }
  const option = procedure.match(/adding the "(?<v>[^"]+)" option/);
  if (option?.groups) {
    return {
      check: { type: "output_contains", value: option.groups.v },
      rationale: `output must contain the option "${option.groups.v}"`,
    };
  }

  // --- PAM module must be configured --------------------------------------
  // e.g. 'If the module is not configured, is missing, or commented out, this
  //       is a finding.' — expect the *.so module name from the command.
  if (/module is not configured/.test(procedure)) {
    const mod = commands.match(/(?<mod>[\w.-]+\.so)/);
    if (mod?.groups) {
      return {
        check: { type: "output_contains", value: mod.groups.mod },
        rationale: `PAM module "${mod.groups.mod}" must be present in the output`,
      };
    }
  }

  // --- service/firewall status must be active -----------------------------
  // e.g. 'If the above command returns the status as "inactive" ... a finding.'
  if (/status as "inactive"/.test(procedure)) {
    return {
      check: { type: "output_contains", value: "active" },
      rationale: "status output must contain 'active'",
    };
  }

  // Nothing matched — do not guess. A wrong `check` silently produces a
  // wrong pass/fail result, which is the one failure mode an audit tool
  // must avoid.
  return null;
}



async function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) {
    console.error(
      'Usage: npx tsx prisma/seed-cis.ts <benchmark.json> [--name "CIS Ubuntu 24.04"] [--checks overrides.json]',
    );
    process.exit(1);
  }

  const nameFlagIdx = args.indexOf("--name");
  const name =
    nameFlagIdx !== -1 && args[nameFlagIdx + 1]
      ? args[nameFlagIdx + 1]
      : `CIS benchmark (${path.basename(file)})`;

  let overrides: Record<string, CheckType> = {};
  const checksIdx = args.indexOf("--checks");
  if (checksIdx !== -1 && args[checksIdx + 1]) {
    overrides = JSON.parse(readFileSync(args[checksIdx + 1], "utf8"));
  }

  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) {
    console.error("Input file must be a JSON array of CIS rules.");
    process.exit(1);
  }

  const flagged: { rule_id: string; title: string }[] = [];
  const inferred: CisTest[] = [];
  let skipped = 0;

  for (const rule of raw as RawRule[]) {
    if (typeof rule.rule_id !== "string" || !Array.isArray(rule.audit_command)) {
      skipped++;
      continue; // not a parseable rule — ignore rather than guess
    }

    // Rules that already carry a `check` field keep it as-is.
    if (rule.check && typeof rule.check === "object" && "type" in rule.check) {
      inferred.push({ ...(rule as unknown as CisTest), check: rule.check as CheckType });
      continue;
    }

    const override = overrides[rule.rule_id];
    const result = override
      ? { check: override, rationale: "supplied via --checks overrides file" }
      : inferCheck(rule);

    if (!result) {
      flagged.push({ rule_id: rule.rule_id, title: String(rule.title ?? "") });
      // Safe default: not machine-checkable -> manual, excluded from scans
      // by parseCisContent() until reviewed by hand.
      inferred.push({ ...(rule as unknown as CisTest), check: { type: "manual" } });
      continue;
    }

    inferred.push({ ...(rule as unknown as CisTest), check: result.check });
  }

  const automatedCount = inferred.filter(
    (t) => t.automated === true && t.check.type !== "manual",
  ).length;

  // Same name -> update (re-seeding an improved file); new name -> new template.
  const content = inferred as unknown as Prisma.InputJsonValue;
  const existing = await prisma.cisTemplate.findFirst({ where: { name } });
  const template = existing
    ? await prisma.cisTemplate.update({
        where: { id: existing.id },
        data: { content },
      })
    : await prisma.cisTemplate.create({ data: { name, content } });

  console.log(`Seeded CisTemplate "${template.name}" (${template.id})`);
  console.log(`  rules ingested: ${inferred.length}`);
  console.log(`  machine-checkable (automated): ${automatedCount}`);
  console.log(`  malformed rules skipped: ${skipped}`);

  if (flagged.length > 0) {
    console.log(
      `\n  WARNING: ${flagged.length} rule(s) marked { "type": "manual" } — the correct check type is ` +
        `ambiguous from the audit text alone and must be reviewed by hand before ` +
        `the template is used for scanning:`,
    );
    for (const f of flagged) {
      console.log(`    - ${f.rule_id}: ${f.title}`);
    }
    console.log(
      `\n  Decide each one, then re-run with --checks overrides.json mapping ` +
        `rule_id -> CheckType to apply the reviewed values.`,
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
