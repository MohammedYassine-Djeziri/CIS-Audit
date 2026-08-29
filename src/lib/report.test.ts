import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  ReportDataError,
  buildReportFilename,
  generateComplianceReport,
  type ReportData,
} from "./report";
import type { StoredRuleResult } from "./types";

/**
 * Extracts readable text from a generated PDF: content streams are
 * Flate-compressed AND pdfkit encodes text as hex strings (`<4349...> TJ`),
 * so raw-buffer includes() would miss everything. This inflates every
 * stream, decodes hex strings to ASCII, and returns the concatenation —
 * good enough to assert which strings made it into the report.
 */
function pdfText(pdf: Buffer): string {
  const parts: string[] = [];
  const raw = pdf.toString("latin1");
  // NOTE: "(?<!end)" so the tail of "endstream" does not match — that would
  // misalign the scan and skip the next page's content stream.
  const re = /(?<!end)stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end === -1) break;
    const slice = pdf.subarray(start, end);
    let content: string;
    try {
      content = zlib.inflateSync(slice).toString("latin1");
    } catch {
      // Not a Flate-compressed content stream (e.g. an embedded font
      // program) — contributes no text.
      continue;
    }
    // Decode PDF hex strings. pdfkit splits text runs across TJ-array
    // elements with kerning adjustments (`[<...Repor> -20 <t...>] TJ`), so
    // first JOIN adjacent hex strings across those numeric kerns (within
    // `[...] TJ` arrays only — glyph pairs like `<48> 10 <65>` must not
    // lose their word boundaries... they don't: spaces live INSIDE the hex
    // strings, kerns only separate runs of the same word).
    content = content.replace(
      /\[((?:<[0-9A-Fa-f\s]*>|-?[\d.]+|[\s])*)\]\s*TJ/g,
      (_m, arr: string) =>
        (arr.match(/<[0-9A-Fa-f\s]*>/g) ?? [])
          .map((h) => Buffer.from(h.slice(1, -1).replace(/\s+/g, ""), "hex").toString("latin1"))
          .join(""),
    );
    // Any remaining standalone hex strings (plain `(...) Tj` / second runs).
    content = content.replace(/<([0-9A-Fa-f\s]+)>/g, (_m, hex: string) =>
      Buffer.from(hex.replace(/\s+/g, ""), "hex").toString("latin1"),
    );
    parts.push(content);
    re.lastIndex = end;
  }
  return parts.join("\n");
}

// NOTE: report.ts imports "server-only", which throws outside a React Server
// Components context. These tests run through the project's loader setup
// (see package.json test script / tsconfig module resolution).

function baseData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    scanId: "0193d6f2-a1b2-7c3d-8e4f-a0566ad09911",
    scannedAt: new Date("2026-08-29T12:00:00Z"),
    assetTitle: "Production / Web Server #1",
    ipAddress: "10.0.0.5",
    username: "auditor",
    cisName: "Ubuntu 24.04 CIS",
    score: 82,
    passed: 82,
    failed: 13,
    errors: 5,
    total: 100,
    results: [],
    ...overrides,
  };
}

function rule(status: StoredRuleResult["status"], id: string): StoredRuleResult {
  return {
    rule_id: id,
    number: "1.70",
    title: `Rule ${id}`,
    severity: "CAT I",
    status,
    auditCommands: ["sudo awk -F: '!$2 {print $1}' /etc/shadow"],
    auditProcedure: "Verify all accounts have a password.",
    remediation: "Configure all accounts to have a password.",
    executions: [
      {
        command: "sudo awk -F: '!$2 {print $1}' /etc/shadow",
        stdout: status === "failed" ? "test-account\nlegacy-account" : "",
        stderr: "",
        exitCode: 1,
      },
    ],
    executionMode: "sudo",
    ...(status === "error" ? { error: "Command timed out after 60 seconds.", exit_code: -1 } : {}),
  };
}

// --- Count validation (report plan §9/§30) ---------------------------------

test("generateComplianceReport rejects counts that do not add up to total", async () => {
  await assert.rejects(
    generateComplianceReport(baseData({ passed: 90, failed: 13, errors: 5, total: 100 })),
    ReportDataError,
  );
});

test("generateComplianceReport rejects non-integer and out-of-range data", async () => {
  await assert.rejects(
    generateComplianceReport(baseData({ passed: 82.5, total: 100.5 })),
    ReportDataError,
  );
  await assert.rejects(generateComplianceReport(baseData({ score: 145 })), ReportDataError);
});

test("generateComplianceReport rejects a results array inconsistent with counts", async () => {
  // Counts claim 82/13/5 but the snapshot carries only one failed rule.
  await assert.rejects(
    generateComplianceReport(baseData({ results: [rule("failed", "UBTU-24-300027")] })),
    ReportDataError,
  );
});

// --- Successful generation across the required scenarios (§22–§24) ---------

test("generates a PDF for an all-passed scan", async () => {
  const results = Array.from({ length: 3 }, (_, i) => rule("passed", `UBTU-24-6001${i}0`));
  const pdf = await generateComplianceReport(
    baseData({ score: 100, passed: 3, failed: 0, errors: 0, total: 3, results }),
  );
  assert.ok(pdf.subarray(0, 5).toString("latin1").startsWith("%PDF-"));
  const text = pdfText(pdf);
  assert.ok(text.includes("Appendix")); // passed-rules appendix present
  assert.ok(text.includes("Failed Rules (0)"));
});

test("generates a PDF for an all-failed scan with evidence and remediation", async () => {
  const results = [rule("failed", "UBTU-24-300027")];
  const pdf = await generateComplianceReport(
    baseData({ score: 0, passed: 0, failed: 1, errors: 0, total: 1, results }),
  );
  assert.ok(pdf.subarray(0, 5).toString("latin1").startsWith("%PDF-"));
  const text = pdfText(pdf);
  assert.ok(text.includes("Failed Rules (1)"));
  assert.ok(text.includes("UBTU-24-300027"));
  // Evidence (sanitized stdout) and remediation are rendered.
  assert.ok(text.includes("test-account"));
  assert.ok(text.includes("Configure all accounts"));
});

test("generates a PDF with a separate error section for unevaluated rules", async () => {
  const results = [rule("failed", "UBTU-24-300027"), rule("error", "UBTU-24-600150")];
  const pdf = await generateComplianceReport(
    baseData({ score: 0, passed: 0, failed: 1, errors: 1, total: 2, results }),
  );
  const text = pdfText(pdf);
  assert.ok(text.includes("Rules That Could Not Be Evaluated (1)"));
  assert.ok(text.includes("UBTU-24-600150"));
  assert.ok(text.includes("Command timed out"));
  // The error section must NOT present CIS remediation as the fix.
  assert.ok(!text.includes("Configure all accounts to have a password or lock"));
});

test("generates a PDF for a zero-result snapshot (degenerate ring, no crash)", async () => {
  const pdf = await generateComplianceReport(
    baseData({ score: 0, passed: 0, failed: 0, errors: 0, total: 0, results: [] }),
  );
  assert.ok(pdf.subarray(0, 5).toString("latin1").startsWith("%PDF-"));
});

// --- Filename sanitization (report plan §1) --------------------------------

test("buildReportFilename sanitizes asset and CIS names", () => {
  const name = buildReportFilename(
    "Production / Web Server #1",
    "Ubuntu 24.04 CIS",
    new Date("2026-08-29T12:00:00Z"),
  );
  assert.equal(name, "Production-Web-Server-1-Ubuntu-24.04-CIS-report-2026-08-29.pdf");
  assert.ok(!name.includes("/"));
  assert.ok(!name.includes("#"));
});

test("buildReportFilename falls back when names sanitize to empty", () => {
  const name = buildReportFilename("///", "***", new Date("2026-08-29T12:00:00Z"));
  assert.equal(name, "asset-cis-report-2026-08-29.pdf");
});
