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
  // PDFKit encodes text as WinAnsi bytes in hex strings ("<434953...>"),
  // NOT UTF-8 — so '—' (U+2014) becomes byte 0x97. Decoding with
  // windows-1252 maps the 0x80–0x9F range to the correct glyphs where plain
  // latin1 would produce control characters. ASCII is unaffected.
  const winAnsi = new TextDecoder("windows-1252");
  const decodeHex = (hex: string): string =>
    winAnsi.decode(Buffer.from(hex.replace(/\s+/g, ""), "hex"));
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
        (arr.match(/<[0-9A-Fa-f\s]*>/g) ?? []).map((h) => decodeHex(h.slice(1, -1))).join(""),
    );
    // Any remaining standalone hex strings (plain `(...) Tj` / second runs).
    content = content.replace(/<([0-9A-Fa-f\s]+)>/g, (_m, hex: string) => decodeHex(hex));
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
  assert.ok(text.includes("All evaluated rules passed."));
  assert.ok(!text.includes("Failed Rule 1")); // no findings section
});

test("generates a PDF for an all-failed scan with evidence and remediation", async () => {
  const results = [rule("failed", "UBTU-24-300027")];
  const pdf = await generateComplianceReport(
    baseData({ score: 0, passed: 0, failed: 1, errors: 0, total: 1, results }),
  );
  assert.ok(pdf.subarray(0, 5).toString("latin1").startsWith("%PDF-"));
  const text = pdfText(pdf);
  assert.ok(text.includes("Failed Rule 1"));
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
  assert.ok(text.includes("Rules That Could Not Be Evaluated"));
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
  const text = pdfText(pdf);
  assert.ok(text.includes("No automated rules were available for evaluation."));
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

// --- Layout / pagination regression fixtures (visual review) ----------------

/** Number of PDF page objects (not /Pages) — a cheap page count. */
function pageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

test("footers number every page of a multi-page report (bufferPages)", async () => {
  // 100-rule passed appendix forces several pages.
  const results = Array.from({ length: 100 }, (_, i) =>
    rule("passed", `UBTU-24-9${String(i).padStart(4, "0")}`),
  );
  const pdf = await generateComplianceReport(
    baseData({ score: 100, passed: 100, failed: 0, errors: 0, total: 100, results }),
  );
  const pages = pageCount(pdf);
  assert.ok(pages > 1, `expected a multi-page report, got ${pages} page(s)`);
  const text = pdfText(pdf);
  // Every page carries a "Page X of Y" footer with the CORRECT total —
  // without bufferPages only the last page would say "Page 1 of 1".
  assert.ok(text.includes(`Page 1 of ${pages}`));
  assert.ok(text.includes(`Page ${pages} of ${pages}`));
  assert.ok(!text.includes("Page 1 of 1"));
  // The appendix header is repeated on each page the table continues onto.
  const headerCount = (text.match(/RULE ID/g) ?? []).length;
  assert.ok(headerCount >= 2, "appendix header should repeat on continuation pages");
});

test("a remediation longer than one page flows across paginated boxes", async () => {
  const longRemediation = Array.from(
    { length: 300 },
    (_, i) => `Step ${i + 1}: perform remediation action ${i + 1} on the affected host.`,
  ).join("\n");
  const failed = { ...rule("failed", "UBTU-24-300027"), remediation: longRemediation };
  const pdf = await generateComplianceReport(
    baseData({ score: 0, passed: 0, failed: 1, errors: 0, total: 1, results: [failed] }),
  );
  const pages = pageCount(pdf);
  assert.ok(pages > 1, "long remediation must push the report past one page");
  const text = pdfText(pdf);
  assert.ok(text.includes("Step 1:"), "first portion present");
  assert.ok(text.includes("Step 300:"), "final portion present — nothing clipped");
  assert.ok(text.includes("(continued)"), "continuation marker drawn");
});

test("a very long command is not clipped and keeps its evidence label", async () => {
  const longCommand = `sudo awk -F: '!$2 {print $1}' /etc/shadow && ${"echo continuation-of-a-very-long-audit-command-pipeline ".repeat(40)}done`;
  const failed = {
    ...rule("failed", "UBTU-24-300027"),
    auditCommands: [longCommand],
    executions: [{ command: longCommand, stdout: "root\n", stderr: "", exitCode: 1 }],
  };
  const pdf = await generateComplianceReport(
    baseData({ score: 0, passed: 0, failed: 1, errors: 0, total: 1, results: [failed] }),
  );
  const text = pdfText(pdf);
  assert.ok(text.includes("COMMAND EXECUTED"));
  assert.ok(text.includes("done"), "command tail survives — not clipped by the box");
  assert.ok(text.includes("root"), "evidence rendered");
});

test("multiline evidence rows and mixed 82/13/5 legend percentages", async () => {
  const failedWithMultiline = {
    ...rule("failed", "UBTU-24-300027"),
    executions: [
      {
        command: "sudo awk -F: '!$2 {print $1}' /etc/shadow",
        stdout: "account-one\naccount-two\naccount-three\naccount-four",
        stderr: "warning: legacy entries present",
        exitCode: 1,
      },
    ],
  };
  const results = [
    ...Array.from({ length: 82 }, (_, i) => rule("passed", `UBTU-24-8${String(i).padStart(4, "0")}`)),
    failedWithMultiline,
    ...Array.from({ length: 12 }, (_, i) => rule("failed", `UBTU-24-3${String(i).padStart(4, "0")}`)),
    ...Array.from({ length: 5 }, (_, i) => rule("error", `UBTU-24-6${String(i).padStart(4, "0")}`)),
  ];
  const pdf = await generateComplianceReport(
    baseData({ score: 82, passed: 82, failed: 13, errors: 5, total: 100, results }),
  );
  const text = pdfText(pdf);
  // Legend shows explicit percentages next to raw counts.
  assert.ok(text.includes("Passed — 82 (82%)"));
  assert.ok(text.includes("Failed — 13 (13%)"));
  assert.ok(text.includes("Errors — 5 (5%)"));
  assert.ok(text.includes("account-three"), "multiline evidence fully rendered");
});

test("generates a correct mixed-result doughnut report (54/34/12)", async () => {
  // The screenshot fixture from the bug report: one segment per color, no
  // single category dominating (no full-circle shortcut taken).
  const results = [
    ...Array.from({ length: 54 }, (_, i) =>
      rule("passed", `UBTU-24-100${String(i).padStart(3, "0")}`),
    ),
    ...Array.from({ length: 34 }, (_, i) =>
      rule("failed", `UBTU-24-200${String(i).padStart(3, "0")}`),
    ),
    ...Array.from({ length: 12 }, (_, i) =>
      rule("error", `UBTU-24-300${String(i).padStart(3, "0")}`),
    ),
  ];

  const pdf = await generateComplianceReport(
    baseData({
      score: 54,
      passed: 54,
      failed: 34,
      errors: 12,
      total: 100,
      results,
    }),
  );

  assert.ok(pdf.subarray(0, 5).toString("latin1").startsWith("%PDF-"));

  const text = pdfText(pdf);
  assert.ok(text.includes("54%"), "score rendered in the doughnut hole");
  assert.ok(text.includes("Passed — 54 (54%)"));
  assert.ok(text.includes("Failed — 34 (34%)"));
  assert.ok(text.includes("Errors — 12 (12%)"));
});

test("an all-error report does not masquerade as a clean pass", async () => {
  const results = Array.from({ length: 3 }, (_, i) =>
    rule("error", `UBTU-24-7${String(i).padStart(4, "0")}`),
  );
  const pdf = await generateComplianceReport(
    baseData({ score: 0, passed: 0, failed: 0, errors: 3, total: 3, results }),
  );
  const text = pdfText(pdf);
  assert.ok(text.includes("No confirmed compliance findings."));
  assert.ok(!text.includes("All evaluated rules passed."));
});

test("rejects NaN and non-finite scores (range comparisons miss NaN)", async () => {
  await assert.rejects(
    generateComplianceReport(
      baseData({ score: NaN, passed: 0, failed: 0, errors: 0, total: 0, results: [] }),
    ),
    ReportDataError,
  );
  await assert.rejects(
    generateComplianceReport(
      baseData({ score: Infinity, passed: 0, failed: 0, errors: 0, total: 0, results: [] }),
    ),
    ReportDataError,
  );
});

test("very long asset and CIS names produce a valid report and safe filename", async () => {
  const longAsset = `${"Extremely Long Production Server Name ".repeat(10)}1`;
  const longCis = `${"Ubuntu 24.04 CIS Benchmark Level ".repeat(10)}1`;
  const pdf = await generateComplianceReport(
    baseData({
      assetTitle: longAsset,
      cisName: longCis,
      score: 100,
      passed: 1,
      failed: 0,
      errors: 0,
      total: 1,
      results: [rule("passed", "UBTU-24-600110")],
    }),
  );
  assert.ok(pdf.subarray(0, 5).toString("latin1").startsWith("%PDF-"));
  const text = pdfText(pdf);
  assert.ok(text.includes("Extremely Long Production Server Name"));
  const name = buildReportFilename(longAsset, longCis, new Date("2026-08-29T12:00:00Z"));
  assert.ok(name.length < 250, "filename stays header-safe");
  assert.ok(!name.includes("/"));
});


