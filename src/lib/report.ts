import "server-only";
import PDFDocument from "pdfkit";
import type { StoredRuleResult } from "./types";
import { sanitizeFilenamePart } from "./sanitize";

/**
 * Compliance report generator (report feature plan §8–§12, §21).
 *
 * Server-only: the ONLY input is the persisted scan snapshot loaded by
 * GET /api/reports/[scanId] — never anything the browser supplied. The
 * generator renders with PDFKit primitives (text, rects, vector arcs), so
 * template values (descriptions, remediation, evidence) are always treated
 * as TEXT — no HTML escaping concerns (report plan §2), and command text is
 * reproduced verbatim, including shell characters like `$` and `|`.
 *
 * Structure:
 *   1. Header — report identity + asset information + scan summary.
 *   2. Doughnut chart — green/red/orange segments with the score in the
 *      middle, drawn from the saved counts (never recomputed separately).
 *   3. Failed rules — one section per finding: audit procedure, original
 *      commands, sanitized evidence, remediation in a distinct box.
 *   4. "Rules That Could Not Be Evaluated" — execution errors, separate
 *      from findings, with the sanitized reason and a compliance-state note
 *      (CIS remediation is deliberately NOT shown for these).
 *   5. Passed-rules appendix — one compact line per passing rule.
 */

export class ReportDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportDataError";
  }
}

export interface ReportData {
  scanId: string;
  scannedAt: Date;
  assetTitle: string;
  ipAddress: string;
  username: string;
  cisName: string;
  score: number;
  passed: number;
  failed: number;
  errors: number;
  total: number;
  results: StoredRuleResult[];
}

// Palette (Bootstrap-consistent, report plan §9)
const GREEN = "#198754";
const RED = "#dc3545";
const AMBER = "#ffc107";
const TEXT = "#212529";
const MUTED = "#6c757d";
const BOX_FILL = "#f8f9fa";
const BOX_BORDER = "#dee2e6";
const REMEDIATION_FILL = "#fff8e6";
const REMEDIATION_BORDER = "#e0a800";

const PAGE_MARGIN = 50;
const CONTENT_WIDTH = 495; // A4 width (595.28) minus two 50pt margins

type Doc = PDFKit.PDFDocument;

// ---------------------------------------------------------------------------
// Small layout helpers
// ---------------------------------------------------------------------------

function ensureSpace(doc: Doc, needed: number): void {
  if (doc.y + needed > doc.page.maxY()) {
    doc.addPage();
  }
}

function sectionHeading(doc: Doc, text: string): void {
  ensureSpace(doc, 40);
  doc.moveDown(1);
  doc.font("Helvetica-Bold").fontSize(14).fillColor(TEXT).text(text, { characterSpacing: 0.2 });
  const lineY = doc.y + 2;
  doc
    .moveTo(PAGE_MARGIN, lineY)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, lineY)
    .lineWidth(1)
    .strokeColor(BOX_BORDER)
    .stroke();
  doc.moveDown(0.5);
}

function label(doc: Doc, text: string): void {
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED).text(text.toUpperCase(), {
    characterSpacing: 0.8,
  });
  doc.moveDown(0.15);
}

/** Body text that preserves the template's line breaks. */
function body(doc: Doc, text: string, color = TEXT): void {
  doc.font("Helvetica").fontSize(9.5).fillColor(color).text(text, { lineGap: 1.5 });
}

/**
 * A shaded, bordered monospace box sized to its content (commands, evidence).
 * Text is rendered as text — no escaping needed — with pre-wrap semantics.
 */
function codeBox(doc: Doc, text: string): void {
  const pad = 6;
  const innerWidth = CONTENT_WIDTH - pad * 2;
  const height = doc.font("Courier").fontSize(8.5).heightOfString(text, {
    width: innerWidth,
    lineGap: 1,
  });
  ensureSpace(doc, height + pad * 2 + 6);
  const top = doc.y;
  doc
    .roundedRect(PAGE_MARGIN, top, CONTENT_WIDTH, height + pad * 2, 3)
    .fillColor(BOX_FILL)
    .fill()
    .lineWidth(0.75)
    .strokeColor(BOX_BORDER)
    .stroke();
  doc
    .font("Courier")
    .fontSize(8.5)
    .fillColor(TEXT)
    .text(text, PAGE_MARGIN + pad, top + pad, { width: innerWidth, lineGap: 1 });
  doc.x = PAGE_MARGIN;
  doc.y = top + height + pad * 2 + 6;
}

function keyValueLine(doc: Doc, pairs: Array<[string, string]>): void {
  const line = pairs.map(([k, v]) => `${k}: ${v}`).join("    ");
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(line);
  doc.moveDown(0.2);
}

// ---------------------------------------------------------------------------
// Doughnut chart (report plan §9) — pure vector, no charting dependency
// ---------------------------------------------------------------------------

/**
 * PDFKit supports vector arcs, but @types/pdfkit doesn't declare `arc` on
 * the fluent document type. Declare the whole path-building chain here so
 * the doughnut segment path stays fully typed and fluent — every method
 * returns VectorDoc so the calls can be chained like PDFKit allows at
 * runtime.
 */
type VectorDoc = Doc & {
  moveTo(x: number, y: number): VectorDoc;
  lineTo(x: number, y: number): VectorDoc;
  arc(
    x: number,
    y: number,
    r: number,
    startAngle: number,
    endAngle: number,
    clockwise?: boolean,
  ): VectorDoc;
  closePath(): VectorDoc;
};

function drawDoughnut(doc: Doc, data: ReportData): void {
  // Reserve space BEFORE computing positions, so a page break here doesn't
  // leave the chart drawn past the bottom of the previous page.
  ensureSpace(doc, 190);
  const cx = PAGE_MARGIN + 75;
  const cy = doc.y + 80;
  const rOuter = 70;
  const rInner = 44;

  // The chart is drawn from the SAVED counts. Segment sizes imply the
  // percentages; the compliance score shown in the middle is the saved
  // score — never recalculated here.
  const segments: Array<{ value: number; color: string }> = [
    { value: data.passed, color: GREEN },
    { value: data.failed, color: RED },
    { value: data.errors, color: AMBER },
  ];
  const sum = segments.reduce((acc, s) => acc + s.value, 0);

  if (sum === 0) {
    // Degenerate case — draw an empty ring rather than nothing at all.
    doc
      .circle(cx, cy, rOuter)
      .lineWidth(rOuter - rInner)
      .strokeColor(BOX_BORDER)
      .stroke();
  } else {
    const fullSegment = segments.find((s) => s.value === sum);
    if (fullSegment) {
      // 100% of one category: outer disc + inner hole.
      doc.circle(cx, cy, rOuter).fillColor(fullSegment.color).fill();
      doc.circle(cx, cy, rInner).fillColor("#ffffff").fill();
    } else {
      let angle = -Math.PI / 2;
      const vector = doc as VectorDoc;
      for (const seg of segments) {
        if (seg.value === 0) continue;
        const sweep = (seg.value / sum) * Math.PI * 2;
        const a0 = angle;
        const a1 = angle + sweep;
        vector
          .moveTo(cx + rOuter * Math.cos(a0), cy + rOuter * Math.sin(a0))
          .arc(cx, cy, rOuter, a0, a1, false)
          .lineTo(cx + rInner * Math.cos(a1), cy + rInner * Math.sin(a1))
          .arc(cx, cy, rInner, a1, a0, true)
          .closePath()
          .fillColor(seg.color)
          .fill();
        angle = a1;
      }
    }
  }

  // Compliance score in the center of the ring.
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor(TEXT)
    .text(`${data.score}%`, cx - rInner, cy - 12, { width: rInner * 2, align: "center" });

  // Legend, to the right of the chart.
  const legendX = cx + rOuter + 30;
  let legendY = cy - 32;
  const legend: Array<[string, string]> = [
    [`Passed — ${data.passed}`, GREEN],
    [`Failed — ${data.failed}`, RED],
    [`Errors — ${data.errors}`, AMBER],
  ];
  for (const [text, color] of legend) {
    doc.circle(legendX, legendY, 5).fillColor(color).fill();
    doc.font("Helvetica").fontSize(10).fillColor(TEXT).text(text, legendX + 12, legendY - 6, {
      lineBreak: false,
    });
    legendY += 22;
  }

  doc.x = PAGE_MARGIN;
  doc.y = cy + rOuter + 18;
}

// ---------------------------------------------------------------------------
// Rule sections
// ---------------------------------------------------------------------------

function failedRuleSection(doc: Doc, rule: StoredRuleResult, position: number): void {
  ensureSpace(doc, 140);
  doc.moveDown(0.5);
  doc
    .font("Helvetica-Bold")
    .fontSize(11.5)
    .fillColor(TEXT)
    .text(`${position}. ${rule.rule_id} — ${rule.title}`, { lineGap: 1 });
  doc.moveDown(0.2);
  keyValueLine(doc, [
    ["Severity", rule.severity],
    ["Rule number", rule.number],
    ["Status", "Failed"],
  ]);

  if (rule.auditProcedure) {
    label(doc, "Description / audit procedure");
    body(doc, rule.auditProcedure);
    doc.moveDown(0.3);
  }

  if (rule.auditCommands.length > 0) {
    label(doc, "Command executed");
    const multiple = rule.auditCommands.length > 1;
    rule.auditCommands.forEach((cmd, i) => {
      if (multiple) {
        doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Command ${i + 1}`);
        doc.moveDown(0.1);
      }
      codeBox(doc, cmd);
    });
  }

  // Evidence: sanitized, truncated command output (report plan §10). Stored
  // outputs were already scrubbed and capped at scan time; labeled sensitive.
  const evidence = rule.executions
    .map((e) => e.stdout.trim())
    .filter((stdout) => stdout.length > 0);
  if (evidence.length > 0) {
    label(doc, "Finding evidence (sensitive)");
    const multiple = evidence.length > 1;
    evidence.forEach((stdout, i) => {
      if (multiple) {
        doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Output of command ${i + 1}`);
        doc.moveDown(0.1);
      }
      codeBox(doc, stdout);
    });
    body(
      doc,
      "Note: command output may contain sensitive system information. It is included to document the finding and has been truncated when excessively large.",
      MUTED,
    );
    doc.moveDown(0.3);
  }

  if (rule.remediation) {
    const pad = 6;
    const innerWidth = CONTENT_WIDTH - pad * 2;
    const height = doc.font("Helvetica").fontSize(9.5).heightOfString(rule.remediation, {
      width: innerWidth,
      lineGap: 1.5,
    });
    ensureSpace(doc, height + pad * 2 + 30);
    label(doc, "Remediation");
    const top = doc.y;
    doc
      .roundedRect(PAGE_MARGIN, top, CONTENT_WIDTH, height + pad * 2, 3)
      .fillColor(REMEDIATION_FILL)
      .fill()
      .lineWidth(0.75)
      .strokeColor(REMEDIATION_BORDER)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(TEXT)
      .text(rule.remediation, PAGE_MARGIN + pad, top + pad, { width: innerWidth, lineGap: 1.5 });
    doc.x = PAGE_MARGIN;
    doc.y = top + height + pad * 2 + 10;
  }

  doc.moveDown(0.5);
}

function errorRuleSection(doc: Doc, rule: StoredRuleResult, position: number): void {
  ensureSpace(doc, 140);
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").fontSize(11.5).fillColor(TEXT).text(`${position}. ${rule.rule_id}`);
  doc.moveDown(0.2);
  keyValueLine(doc, [
    ["Title", rule.title],
    ["Severity", rule.severity],
    ["Status", "Error"],
  ]);

  if (rule.auditCommands.length > 0) {
    label(doc, "Command");
    const multiple = rule.auditCommands.length > 1;
    rule.auditCommands.forEach((cmd, i) => {
      if (multiple) {
        doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Command ${i + 1}`);
        doc.moveDown(0.1);
      }
      codeBox(doc, cmd);
    });
  }

  // Execution reason — NOT the CIS remediation (report plan §11): an error
  // means compliance could not be determined, not that a finding exists.
  if (rule.error) {
    label(doc, "Reason");
    codeBox(doc, rule.error);
  }
  if (typeof rule.exit_code === "number" && rule.exit_code >= 0) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`Exit code: ${rule.exit_code}`);
    doc.moveDown(0.2);
  }
  body(
    doc,
    "The compliance state of this rule is unknown. The audit command could not be evaluated — this is a scanner execution problem, not a compliance finding.",
    MUTED,
  );
  doc.moveDown(0.5);
}

function passedAppendix(doc: Doc, passedRules: StoredRuleResult[]): void {
  sectionHeading(doc, `Appendix — Passed Rules (${passedRules.length})`);
  body(
    doc,
    "The following rules were executed and confirmed compliant. Full audit procedures and remediations are intentionally omitted for passing rules.",
    MUTED,
  );
  doc.moveDown(0.3);

  const ruleLineY = doc.y;
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(MUTED)
    .text("RULE ID", PAGE_MARGIN, ruleLineY, { lineBreak: false });
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(MUTED)
    .text("TITLE", PAGE_MARGIN + 130, ruleLineY, { lineBreak: false });
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(MUTED)
    .text("SEVERITY", PAGE_MARGIN + 400, ruleLineY, { lineBreak: false });
  doc.moveDown(0.2);
  const headerRuleY = doc.y;
  doc
    .moveTo(PAGE_MARGIN, headerRuleY)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, headerRuleY)
    .lineWidth(0.5)
    .strokeColor(BOX_BORDER)
    .stroke();
  doc.moveDown(0.2);

  for (const rule of passedRules) {
    ensureSpace(doc, 26);
    const y = doc.y;
    doc.font("Courier").fontSize(8).fillColor(TEXT).text(rule.rule_id, PAGE_MARGIN, y, {
      width: 125,
      lineBreak: false,
    });
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(TEXT)
      .text(rule.title, PAGE_MARGIN + 130, y, { width: 265, lineBreak: false });
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(MUTED)
      .text(`${rule.severity}  #${rule.number}`, PAGE_MARGIN + 400, y, {
        width: 95,
        lineBreak: false,
      });
    doc.moveDown(0.9);
  }
}

// ---------------------------------------------------------------------------
// Filename (report plan §1)
// ---------------------------------------------------------------------------

/**
 * `asset-cis-report-YYYY-MM-DD.pdf`, with asset/CIS names sanitized so
 * slashes, `#`, control characters, etc. can never break the
 * Content-Disposition header or the filesystem (report plan §1).
 */
export function buildReportFilename(assetTitle: string, cisName: string, scannedAt: Date): string {
  const assetPart = sanitizeFilenamePart(assetTitle) || "asset";
  const cisPart = sanitizeFilenamePart(cisName) || "cis";
  const datePart = scannedAt.toISOString().slice(0, 10);
  return `${assetPart}-${cisPart}-report-${datePart}.pdf`;
}

// ---------------------------------------------------------------------------
// Entry point (report plan §15/§21)
// ---------------------------------------------------------------------------

/**
 * Generates the PDF and resolves with its bytes. Rejects with
 * ReportDataError when the snapshot is internally inconsistent
 * (report plan §9: passed + failed + errors must equal total) — the
 * generator refuses to produce a misleading report.
 */
export function generateComplianceReport(data: ReportData): Promise<Buffer> {
  const countsAreIntegers =
    Number.isInteger(data.passed) &&
    Number.isInteger(data.failed) &&
    Number.isInteger(data.errors) &&
    Number.isInteger(data.total);
  if (!countsAreIntegers) {
    return Promise.reject(new ReportDataError("Scan counts must be integers."));
  }
  if (data.passed + data.failed + data.errors !== data.total) {
    return Promise.reject(
      new ReportDataError(
        `Inconsistent scan snapshot: passed (${data.passed}) + failed (${data.failed}) + errors (${data.errors}) does not equal total (${data.total}).`,
      ),
    );
  }
  if (data.score < 0 || data.score > 100) {
    return Promise.reject(new ReportDataError(`Compliance score out of range: ${data.score}.`));
  }
  if (!Array.isArray(data.results)) {
    return Promise.reject(new ReportDataError("Scan snapshot results must be an array."));
  }

  const failedRules = data.results.filter((r) => r?.status === "failed");
  const errorRules = data.results.filter((r) => r?.status === "error");
  const passedRules = data.results.filter((r) => r?.status === "passed");

  // Defense in depth: the counts saved with the snapshot must describe the
  // SAME results the snapshot carries — each status tally in the array has
  // to match the persisted counters exactly.
  const tally = (status: StoredRuleResult["status"]): number =>
    data.results.filter((r) => r?.status === status).length;
  if (
    tally("passed") !== data.passed ||
    tally("failed") !== data.failed ||
    tally("error") !== data.errors
  ) {
    return Promise.reject(
      new ReportDataError(
        `Scan snapshot results do not match the persisted counts (passed ${tally("passed")}/${data.passed}, failed ${tally("failed")}/${data.failed}, errors ${tally("error")}/${data.errors}).`,
      ),
    );
  }

  return renderReportPdf(data, failedRules, errorRules, passedRules);
}

function renderReportPdf(
  data: ReportData,
  failedRules: StoredRuleResult[],
  errorRules: StoredRuleResult[],
  passedRules: StoredRuleResult[],
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 50, bottom: 50, left: PAGE_MARGIN, right: PAGE_MARGIN },
      info: { Title: `CIS Compliance Report — ${data.assetTitle}` },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ---- 1. Header (report plan §8) -------------------------------------
    doc.font("Helvetica-Bold").fontSize(20).fillColor(TEXT).text("CIS Compliance Report");
    doc.moveDown(0.2);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `Scan ID: ${data.scanId}    Scan date: ${data.scannedAt.toISOString().replace("T", " ").slice(0, 19)} UTC    Report generated: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
        { lineGap: 1.5 },
      );
    doc.moveDown(1);

    label(doc, "Asset information");
    keyValueLine(doc, [
      ["Asset", data.assetTitle],
      ["IP address", data.ipAddress],
      ["SSH username", data.username],
      ["CIS template", data.cisName],
      // Deliberately NO password or authentication information (report §8).
    ]);

    label(doc, "Scan summary");
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(TEXT)
      .text(
        `Compliance score: ${data.score}%    Total automated rules: ${data.total}    Passed: ${data.passed}    Failed: ${data.failed}    Errors: ${data.errors}`,
      );
    doc.moveDown(0.5);

    // ---- 2. Doughnut chart (report plan §9) ------------------------------
    drawDoughnut(doc, data);

    // ---- 3. Failed rules (report plan §10) -------------------------------
    if (failedRules.length > 0) {
      sectionHeading(doc, `Failed Rules (${failedRules.length})`);
      body(
        doc,
        "Each section below documents one confirmed compliance finding: what was audited, how it was audited, the evidence observed, and how to remediate it.",
        MUTED,
      );
      failedRules.forEach((rule, i) => failedRuleSection(doc, rule, i + 1));
    } else {
      sectionHeading(doc, "Failed Rules (0)");
      body(doc, "No compliance findings — every rule that was evaluated passed.", GREEN);
    }

    // ---- 4. Errors (report plan §11) -------------------------------------
    if (errorRules.length > 0) {
      sectionHeading(doc, `Rules That Could Not Be Evaluated (${errorRules.length})`);
      body(
        doc,
        "An error means the scanner could not determine compliance — the audit ran into an execution problem. These are not compliance findings.",
        MUTED,
      );
      errorRules.forEach((rule, i) => errorRuleSection(doc, rule, i + 1));
    }

    // ---- 5. Passed-rules appendix (report plan §12) ----------------------
    if (passedRules.length > 0) {
      passedAppendix(doc, passedRules);
    }

    // Footer page numbers (rendered after the body, onto every buffered page).
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          `Page ${i - range.start + 1} of ${range.count} — Scan ${data.scanId}`,
          PAGE_MARGIN,
          doc.page.maxY() + 20,
          { width: CONTENT_WIDTH, align: "center", lineBreak: false },
        );
    }

    doc.end();
  });
}





