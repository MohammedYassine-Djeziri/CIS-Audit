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
 *   5. Passed-rules appendix — compact rows, wrapping columns, table header
 *      repeated on every page the table continues onto.
 *
 * Layout invariants (visual review fixes):
 *   - `bufferPages: true` so the footer pass can revisit every page.
 *   - Content boxes are PAGE-AWARE: anything taller than the remaining
 *     space breaks across pages into one boxed portion per page, never one
 *     oversized rectangle that gets clipped.
 *   - Box fill and border are drawn with fillAndStroke() — fill() consumes
 *     the path, so a follow-up stroke() would not reliably draw borders.
 *   - A label is never orphaned at a page bottom: label + caption + a first
 *     meaningful box portion are reserved together.
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
// Amber is too light for body text on white — this darker tone carries the
// amber SEMANTICS (caution wording) while the chart legend keeps raw amber.
const AMBER_DARK = "#9a6f00";
const TEXT = "#212529";
const MUTED = "#6c757d";
const BOX_FILL = "#f8f9fa";
const BOX_BORDER = "#dee2e6";
const REMEDIATION_FILL = "#fff8e6";
const REMEDIATION_BORDER = "#e0a800";

const PAGE_MARGIN = 50;
const CONTENT_WIDTH = 495; // A4 width (595.28) minus two 50pt margins

// Command/evidence/remediation box geometry. Separate horizontal and
// vertical padding: 6pt on all sides read as cramped at 8.5–9.5pt, and
// monospace command boxes benefit from extra horizontal padding.
const BOX_PAD_X = 10;
const BOX_PAD_Y = 8;
const BOX_RADIUS = 3;
/** Never start a box portion with less than ~one wrapped line of room. */
const MIN_BOX_INNER = 14;

interface Doc extends PDFKit.PDFDocument {
  // Runtime pdfkit vector API — missing from @types/pdfkit (0.17.6).
  // PDFKit's final argument is `anticlockwise` (not `clockwise`): a comment in
  // older local typings named it backwards, but runtime usage was always right.
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    anticlockwise?: boolean,
  ): this;
}

// ---------------------------------------------------------------------------
// Small layout helpers
// ---------------------------------------------------------------------------

/**
 * Adds a page when `needed` more points would not fit. Returns whether a
 * page break happened, so callers (e.g. the appendix table) can redraw a
 * header on the fresh page.
 */
function ensureSpace(doc: Doc, needed: number): boolean {
  if (doc.y + needed > doc.page.maxY()) {
    doc.addPage();
    doc.x = PAGE_MARGIN;
    doc.y = doc.page.margins.top;
    return true;
  }
  return false;
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

// ---------------------------------------------------------------------------
// Page-aware content boxes (commands, evidence, remediation)
// ---------------------------------------------------------------------------

interface BoxStyle {
  fill: string;
  border: string;
  font: "Courier" | "Helvetica";
  fontSize: number;
  lineGap: number;
  /** Space added below the finished box. */
  gapAfter: number;
}

const CODE_BOX: BoxStyle = {
  fill: BOX_FILL,
  border: BOX_BORDER,
  font: "Courier",
  fontSize: 8.5,
  lineGap: 1,
  gapAfter: 6,
};

const REMEDIATION_BOX: BoxStyle = {
  fill: REMEDIATION_FILL,
  border: REMEDIATION_BORDER,
  font: "Helvetica",
  fontSize: 9.5,
  lineGap: 1.5,
  gapAfter: 10,
};

function boxTextOptions(style: BoxStyle): { width: number; lineGap: number } {
  return { width: CONTENT_WIDTH - BOX_PAD_X * 2, lineGap: style.lineGap };
}

function setBoxFont(doc: Doc, style: BoxStyle): void {
  doc.font(style.font).fontSize(style.fontSize);
}

function measureBoxHeight(doc: Doc, text: string, style: BoxStyle): number {
  setBoxFont(doc, style);
  return doc.heightOfString(text, boxTextOptions(style));
}

/**
 * Splits `text` into the largest prefix whose rendered height fits
 * `maxHeight`, and the remainder. PDFKit's greedy line wrapping depends
 * only on the preceding text, so the tail re-wraps exactly as it would have
 * in the original flow — the split never changes what the reader sees.
 */
function splitForHeight(
  doc: Doc,
  text: string,
  style: BoxStyle,
  maxHeight: number,
): { head: string; tail: string } {
  setBoxFont(doc, style);
  const opts = boxTextOptions(style);
  if (doc.heightOfString(text, opts) <= maxHeight) {
    return { head: text, tail: "" };
  }
  // Binary search the longest fitting prefix (character-accurate; the cut
  // may land mid-word, which reads like a normal text-flow page break).
  let lo = 1;
  let hi = text.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (doc.heightOfString(text.slice(0, mid), opts) <= maxHeight) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { head: text.slice(0, best), tail: text.slice(best) };
}

function drawBoxPortion(
  doc: Doc,
  portion: string,
  style: BoxStyle,
  top: number,
  boxHeight: number,
): void {
  // fillAndStroke paints fill AND border in one pass over the current path;
  // fill() followed by stroke() consumes the path and loses the border.
  doc
    .roundedRect(PAGE_MARGIN, top, CONTENT_WIDTH, boxHeight, BOX_RADIUS)
    .lineWidth(0.75)
    .fillAndStroke(style.fill, style.border);
  doc
    .font(style.font)
    .fontSize(style.fontSize)
    .fillColor(TEXT)
    .text(portion, PAGE_MARGIN + BOX_PAD_X, top + BOX_PAD_Y, boxTextOptions(style));
  doc.x = PAGE_MARGIN;
  doc.y = top + boxHeight;
}

/**
 * Draws `text` inside shaded, bordered boxes that break across pages when
 * the content is taller than the remaining space: one rectangle per page
 * portion, a "(continued)" marker above each continuation, and doc.x/doc.y
 * reset after every portion. Nothing is ever clipped or drawn past the
 * physical page, no matter how long the command, evidence, or remediation.
 */
function paginatedBox(doc: Doc, text: string, style: BoxStyle): void {
  let remaining = text;
  for (;;) {
    if (remaining.length > 0) {
      const innerAvail = doc.page.maxY() - doc.y - BOX_PAD_Y * 2;
      if (innerAvail < MIN_BOX_INNER) {
        // Not even one wrapped line fits — continue on a fresh page.
        doc.addPage();
        doc.x = PAGE_MARGIN;
        doc.y = doc.page.margins.top;
        continue;
      }
      const { head, tail } = splitForHeight(doc, remaining, style, innerAvail);
      if (head.length === 0 && tail.length > 0) {
        // Degenerate guard: never loop forever (one character can never be
        // taller than a full fresh page; unreachable in practice).
        doc.addPage();
        doc.x = PAGE_MARGIN;
        doc.y = doc.page.margins.top;
        continue;
      }
      // Unfinished portions fill the whole available area; the final one
      // hugs its content like the original fixed-size box did.
      const boxHeight =
        tail.length > 0
          ? innerAvail + BOX_PAD_Y * 2
          : measureBoxHeight(doc, head, style) + BOX_PAD_Y * 2;
      drawBoxPortion(doc, head, style, doc.y, boxHeight);
      remaining = tail;
      if (remaining.length === 0) break;
      doc.addPage();
      doc.x = PAGE_MARGIN;
      doc.y = doc.page.margins.top;
      doc.font("Helvetica-Oblique").fontSize(8).fillColor(MUTED).text("(continued)");
      doc.moveDown(0.5);
      continue;
    }
    // Empty content — draw the small empty box (matches the old behavior).
    drawBoxPortion(doc, "", style, doc.y, BOX_PAD_Y * 2);
    break;
  }
  doc.x = PAGE_MARGIN;
  doc.y += style.gapAfter;
}

function measureLabelHeight(doc: Doc, text: string): number {
  doc.font("Helvetica-Bold").fontSize(7.5);
  // Slack covers label()'s moveDown(0.15) and the visual gap to the box.
  return doc.heightOfString(text.toUpperCase(), { characterSpacing: 0.8 }) + 8;
}

function measureCaptionHeight(doc: Doc, text: string): number {
  doc.font("Helvetica").fontSize(8.5);
  return doc.heightOfString(text) + 5;
}

/**
 * Draws an optional muted label and caption immediately followed by a
 * (possibly paginated) content box. The space for label + caption + a first
 * meaningful box portion is reserved BEFORE anything is drawn, so a label
 * ("Command executed", "Output of command 1", "Reason", …) can never be
 * orphaned at the bottom of a page with its box on the next one.
 */
function labelBoxGroup(
  doc: Doc,
  content: string,
  style: BoxStyle,
  opts: { labelText?: string; caption?: string } = {},
): void {
  const reserved =
    (opts.labelText ? measureLabelHeight(doc, opts.labelText) : 0) +
    (opts.caption ? measureCaptionHeight(doc, opts.caption) : 0) +
    MIN_BOX_INNER +
    BOX_PAD_Y * 2;
  ensureSpace(doc, reserved);
  if (opts.labelText) {
    label(doc, opts.labelText);
  }
  if (opts.caption) {
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(opts.caption);
    doc.moveDown(0.1);
  }
  paginatedBox(doc, content, style);
}

// ---------------------------------------------------------------------------
// Header metadata — two-column key/value rows instead of joined one-liners
// ---------------------------------------------------------------------------

const KV_KEY_WIDTH = 110;
const KV_ROW_GAP = 4;

/** One key/value row; the value wraps within the remaining column width. */
function keyValueRow(doc: Doc, key: string, value: string, valueColor = TEXT): void {
  const rowY = doc.y;
  const valueX = PAGE_MARGIN + KV_KEY_WIDTH + 10;
  const valueWidth = CONTENT_WIDTH - KV_KEY_WIDTH - 10;

  doc.font("Helvetica-Bold").fontSize(9).fillColor(MUTED).text(key, PAGE_MARGIN, rowY, {
    width: KV_KEY_WIDTH,
    lineBreak: false,
  });
  const keyHeight = doc.heightOfString(key, { width: KV_KEY_WIDTH });

  const valueHeight = doc.heightOfString(value, { width: valueWidth, lineGap: 1 });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(valueColor)
    .text(value, valueX, rowY - 1, { width: valueWidth, lineGap: 1 });

  // Deterministic cursor: tallest cell + gap (never trust the implicit
  // cursor after absolutely positioned text() calls).
  doc.x = PAGE_MARGIN;
  doc.y = rowY + Math.max(keyHeight, valueHeight) + KV_ROW_GAP;
}

function infoSubHeading(doc: Doc, text: string): void {
  ensureSpace(doc, 34);
  doc.moveDown(0.75);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(TEXT).text(text);
  doc.moveDown(0.25);
}

// ---------------------------------------------------------------------------
// Doughnut chart
// ---------------------------------------------------------------------------

const CHART_CX = PAGE_MARGIN + 95;
const R_OUTER = 70;
const R_INNER = 44;
const SCORE_FONT_SIZE = 26;
const SCORE_LABEL_FONT_SIZE = 8;

/** "82%" (rounded); 0 for a zero total. */
function percentage(value: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

interface LegendItem {
  color: string;
  text: string;
}

function legendItems(d: ReportData): LegendItem[] {
  return [
    { color: GREEN, text: `Passed — ${d.passed} (${percentage(d.passed, d.total)})` },
    { color: RED, text: `Failed — ${d.failed} (${percentage(d.failed, d.total)})` },
    { color: AMBER, text: `Errors — ${d.errors} (${percentage(d.errors, d.total)})` },
  ];
}

function drawLegend(doc: Doc, items: LegendItem[]): void {
  const x = CHART_CX + R_OUTER + 30;
  let y = doc.y + 24;
  doc.font("Helvetica").fontSize(10);
  for (const item of items) {
    // Swatch measured to text: 12pt square vertically centered on the line.
    const lineH = doc.heightOfString(item.text, { width: 250 });
    const boxY = y + (lineH - 9) / 2;
    doc
      .rect(x, boxY, 9, 9)
      .lineWidth(0.5)
      .fillAndStroke(item.color, BOX_BORDER);
    doc.fillColor(TEXT).text(item.text, x + 16, y, { width: 250, lineBreak: false });
    y += lineH + 6;
  }
  doc.x = PAGE_MARGIN;
  doc.y = y + 6;
}

/**
 * Ring segment from aStart to aEnd radians (clockwise, 0 = 12 o'clock).
 * Note: PDFKit's final arc() parameter is `anticlockwise` (the old local
 * type declared it as `clockwise` — misleading; runtime usage was correct).
 */
function ringSegment(
  doc: Doc,
  cx: number,
  cy: number,
  startAngle: number,
  endAngle: number,
): void {
  doc
    .moveTo(
      cx + R_OUTER * Math.cos(startAngle),
      cy + R_OUTER * Math.sin(startAngle),
    )
    .arc(cx, cy, R_OUTER, startAngle, endAngle, false)
    .lineTo(
      cx + R_INNER * Math.cos(endAngle),
      cy + R_INNER * Math.sin(endAngle),
    )
    .arc(cx, cy, R_INNER, endAngle, startAngle, true)
    .closePath();
}

function drawDoughnut(doc: Doc, d: ReportData): void {
  const cy = doc.y + 8 + R_OUTER;
  const ringWidth = R_OUTER - R_INNER;
  const ringRadius = (R_OUTER + R_INNER) / 2;

  if (d.total === 0) {
    // Empty ring. A stroke is centered on the path, so to end up with an
    // outer radius of 70 and inner radius of 44 the circle must be drawn at
    // the RING's midpoint radius with the ring width as the line width —
    // drawing at rOuter with lineWidth (rOuter - rInner) yields a ring of
    // outer radius 83 / inner 57, visibly larger than the data chart.
    doc
      .circle(CHART_CX, cy, ringRadius)
      .lineWidth(ringWidth)
      .strokeColor(BOX_BORDER)
      .stroke();
  } else if (d.passed === d.total) {
    doc.circle(CHART_CX, cy, ringRadius).lineWidth(ringWidth).fillColor(GREEN).fill();
  } else if (d.failed === d.total) {
    doc.circle(CHART_CX, cy, ringRadius).lineWidth(ringWidth).fillColor(RED).fill();
  } else if (d.errors === d.total) {
    doc.circle(CHART_CX, cy, ringRadius).lineWidth(ringWidth).fillColor(AMBER).fill();
  } else {
    const start = -Math.PI / 2;
    let angle = start;
    const ordered: Array<[number, string]> = [
      [d.passed, GREEN],
      [d.failed, RED],
      [d.errors, AMBER],
    ];
    for (const [value, color] of ordered) {
      if (value <= 0) continue;
      const sweep = (value / d.total) * Math.PI * 2;
      const end = angle + sweep;
      ringSegment(doc, CHART_CX, cy, angle, end);
      doc.lineWidth(0.5).fillAndStroke(color, "#ffffff");
      angle = end;
    }
  }

  // Score centered in the hole.
  doc.font("Helvetica-Bold").fontSize(SCORE_FONT_SIZE).fillColor(TEXT);
  const scoreText = `${d.score}%`;
  const scoreW = doc.widthOfString(scoreText);
  doc.text(scoreText, CHART_CX - scoreW / 2, cy - SCORE_FONT_SIZE * 0.72, {
    lineBreak: false,
  });
  doc.font("Helvetica").fontSize(SCORE_LABEL_FONT_SIZE).fillColor(MUTED);
  const capW = doc.widthOfString("SCORE");
  doc.text("SCORE", CHART_CX - capW / 2, cy + 12, {
    characterSpacing: 1.2,
    lineBreak: false,
  });

  doc.x = PAGE_MARGIN;
  doc.y = cy + R_OUTER + 12;
  drawLegend(doc, legendItems(d));
}

// ---------------------------------------------------------------------------
// Passed-rules appendix — wrapping columns, dynamic row height, repeated
// header on every page the table continues onto (no more overlapping rows)
// ---------------------------------------------------------------------------

const COL_ID_WIDTH = 125;
const COL_TITLE_WIDTH = 270;
const COL_SEV_WIDTH = 95;
const COL_ID_X = PAGE_MARGIN;
const COL_TITLE_X = PAGE_MARGIN + 135;
const COL_SEV_X = PAGE_MARGIN + 410;
const ROW_PAD_Y = 3;
const MAX_TITLE_LINES = 3;

interface PassedRow {
  ruleId: string;
  title: string;
  severity: string;
  number: string;
}

function drawPassedTableHeader(doc: Doc): void {
  ensureSpace(doc, 42);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MUTED);
  doc.text("RULE ID", COL_ID_X, doc.y, { width: COL_ID_WIDTH, lineBreak: false });
  doc.text("TITLE", COL_TITLE_X, doc.y, { width: COL_TITLE_WIDTH, lineBreak: false });
  doc.text("SEVERITY", COL_SEV_X, doc.y, { width: COL_SEV_WIDTH, lineBreak: false });
  doc.moveDown(0.6);
  const y = doc.y;
  doc
    .moveTo(PAGE_MARGIN, y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, y)
    .lineWidth(0.75)
    .strokeColor(BOX_BORDER)
    .stroke();
  doc.moveDown(0.4);
}

function measurePassedRowHeight(doc: Doc, row: PassedRow): number {
  const opts = (width: number) => ({ width, lineGap: 0.5 });
  doc.font("Helvetica").fontSize(8.5);

  const idHeight = doc.heightOfString(row.ruleId, opts(COL_ID_WIDTH));
  // Cap the title at three lines so pathological titles cannot consume a
  // whole page; the full title remains available in the scan detail view.
  const titleText = `${row.number} ${row.title}`;
  let titleHeight = doc.heightOfString(titleText, opts(COL_TITLE_WIDTH));
  const lineH = doc.heightOfString("Ag", opts(COL_TITLE_WIDTH));
  if (titleHeight > lineH * MAX_TITLE_LINES) {
    titleHeight = lineH * MAX_TITLE_LINES;
  }
  const sevHeight = doc.heightOfString(`${row.severity} #${row.number}`, opts(COL_SEV_WIDTH));
  return Math.max(idHeight, titleHeight, sevHeight);
}

function drawPassedRow(doc: Doc, row: PassedRow, rowHeight: number): void {
  const opts = (width: number) => ({ width, lineGap: 0.5 });
  const titleText = `${row.number} ${row.title}`;
  const rowY = doc.y;
  doc.font("Helvetica").fontSize(8.5).fillColor(TEXT);
  doc.text(row.ruleId, COL_ID_X, rowY, opts(COL_ID_WIDTH));
  doc.text(titleText, COL_TITLE_X, rowY, {
    ...opts(COL_TITLE_WIDTH),
    height: rowHeight,
    ellipsis: true,
  });
  doc.text(`${row.severity} #${row.number}`, COL_SEV_X, rowY, opts(COL_SEV_WIDTH));

  doc.x = PAGE_MARGIN;
  doc.y = rowY + rowHeight + ROW_PAD_Y * 2;
  const sepY = doc.y - ROW_PAD_Y;
  doc
    .moveTo(PAGE_MARGIN, sepY)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, sepY)
    .lineWidth(0.4)
    .strokeColor(BOX_BORDER)
    .stroke();
}

function passedRows(results: StoredRuleResult[]): PassedRow[] {
  return results
    .filter((r) => r.status === "passed")
    .map((r) => ({
      ruleId: r.rule_id,
      title: r.title,
      severity: r.severity,
      number: r.number,
    }));
}

function drawPassedAppendix(doc: Doc, results: StoredRuleResult[]): void {
  sectionHeading(doc, "Appendix — Rules That Passed");
  const rows = passedRows(results);
  if (rows.length === 0) return;

  // Reserve header + separator + a first row so the header can never sit
  // alone at the bottom of a page.
  ensureSpace(doc, 42 + MIN_BOX_INNER + ROW_PAD_Y * 2 + 1);
  drawPassedTableHeader(doc);
  for (const row of rows) {
    const rowHeight = measurePassedRowHeight(doc, row);
    // Rows are never split; on a page break the header is redrawn first.
    if (ensureSpace(doc, rowHeight + ROW_PAD_Y * 2 + 1)) {
      drawPassedTableHeader(doc);
    }
    drawPassedRow(doc, row, rowHeight);
  }
}

// ---------------------------------------------------------------------------
// Failed rules and evaluation errors
// ---------------------------------------------------------------------------

function sanitizeEvidence(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);
  return parts.join("\n\n");
}

function drawFailedRule(doc: Doc, rule: StoredRuleResult, index: number): void {
  sectionHeading(doc, `Failed Rule ${index}: ${rule.rule_id}`);

  body(doc, `${rule.number} ${rule.title}`);
  body(doc, `Severity: ${rule.severity}`, MUTED);
  doc.moveDown(0.4);

  labelBoxGroup(doc, rule.auditProcedure, CODE_BOX, { labelText: "Audit procedure" });

  rule.auditCommands.forEach((command, i) => {
    const caption =
      rule.auditCommands.length > 1
        ? `Command ${i + 1} of ${rule.auditCommands.length}`
        : undefined;
    labelBoxGroup(doc, command, CODE_BOX, { labelText: "Command executed", caption });
  });

  const executions = rule.executions ?? [];
  executions.forEach((execution, i) => {
    const evidence = sanitizeEvidence(execution.stdout ?? "", execution.stderr ?? "");
    const caption =
      executions.length > 1 ? `Output of command ${i + 1}` : "Command output (sanitized)";
    labelBoxGroup(doc, evidence, CODE_BOX, { labelText: "Evidence", caption });
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED).text(`Exit code: ${execution.exitCode}`);
    doc.moveDown(0.4);
  });

  labelBoxGroup(doc, rule.remediation, REMEDIATION_BOX, { labelText: "Remediation" });
  doc.moveDown(0.5);
}

function drawErrorRule(doc: Doc, rule: StoredRuleResult, index: number): void {
  sectionHeading(doc, `Rule ${index}: ${rule.rule_id} — Could Not Be Evaluated`);

  body(doc, `${rule.number} ${rule.title}`);
  body(doc, `Severity: ${rule.severity}`, MUTED);
  doc.moveDown(0.4);

  const reason = rule.error ?? "Execution failed for an unknown reason.";
  labelBoxGroup(doc, reason, CODE_BOX, { labelText: "Reason" });

  rule.auditCommands.forEach((command, i) => {
    const caption =
      rule.auditCommands.length > 1
        ? `Command ${i + 1} of ${rule.auditCommands.length}`
        : undefined;
    labelBoxGroup(doc, command, CODE_BOX, { labelText: "Command executed", caption });
  });

  // Compliance-state note WITHOUT CIS remediation text (plan §14): an
  // unevaluated rule is not a confirmed pass or failure.
  body(
    doc,
    "This rule could not be evaluated, so its compliance state is unknown. " +
      "It is not counted as a finding, but it is not verified as passing either.",
    AMBER_DARK,
  );
  doc.moveDown(0.5);
}

// ---------------------------------------------------------------------------
// Summary statement — wording reflects every state (all-error reports must
// not masquerade as clean, all-green reports)
// ---------------------------------------------------------------------------

function drawSummaryStatement(doc: Doc, d: ReportData): void {
  doc.moveDown(0.75);
  ensureSpace(doc, 44);
  if (d.failed === 0 && d.errors === 0 && d.passed > 0) {
    body(doc, "All evaluated rules passed.", GREEN);
  } else if (d.failed === 0 && d.errors > 0) {
    body(
      doc,
      `No confirmed compliance findings. However, ${d.errors} rule${
        d.errors === 1 ? " could not be" : "s could not be"
      } evaluated.`,
      AMBER_DARK,
    );
  } else if (d.failed > 0) {
    body(
      doc,
      `${d.failed} rule${d.failed === 1 ? "" : "s"} ${
        d.failed === 1 ? "does" : "do"
      } not comply with the benchmark.`,
      RED,
    );
  } else {
    // Zero automated rules were available for evaluation.
    body(doc, "No automated rules were available for evaluation.", MUTED);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function validateReportData(data: ReportData): void {
  const parts = [data.passed, data.failed, data.errors];
  if (parts.some((p) => !Number.isInteger(p) || p < 0) || !Number.isInteger(data.total)) {
    throw new ReportDataError("Counts must be non-negative integers");
  }
  if (data.passed + data.failed + data.errors !== data.total) {
    throw new ReportDataError("Counts must add up to total");
  }
  // NaN sneaks past range comparisons (both < and > are false), so require
  // a finite integer explicitly.
  if (!Number.isFinite(data.score) || !Number.isInteger(data.score)) {
    throw new ReportDataError("Score must be a finite integer");
  }
  if (data.score < 0 || data.score > 100) {
    throw new ReportDataError("Score must be between 0 and 100");
  }
  if (data.results.length !== data.total) {
    throw new ReportDataError("Results array length must equal total");
  }
}

export async function generateComplianceReport(data: ReportData): Promise<Buffer> {
  validateReportData(data);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      // Buffer every page so the footer pass can revisit them; without
      // this, PDFKit flushes finished pages and footers land only on the
      // last page ("Page 1 of 1").
      bufferPages: true,
      margins: { top: 50, bottom: 50, left: PAGE_MARGIN, right: PAGE_MARGIN },
      info: { Title: `CIS Compliance Report — ${data.assetTitle}` },
    }) as Doc;
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    // Buffer (a Uint8Array subclass) so byte-slicing + toString("latin1")
    // behave as callers/tests expect (plain Uint8Array#toString ignores the
    // encoding argument and joins numbers with commas).
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // -- Cover / header -----------------------------------------------------
    doc.font("Helvetica-Bold").fontSize(20).fillColor(TEXT).text("CIS Compliance Report");
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`Scan ID: ${data.scanId}`);
    doc.moveDown(0.75);

    infoSubHeading(doc, "Asset information");
    keyValueRow(doc, "Asset", data.assetTitle);
    keyValueRow(doc, "IP address", data.ipAddress);
    keyValueRow(doc, "SSH username", data.username);
    keyValueRow(doc, "CIS template", data.cisName);

    infoSubHeading(doc, "Scan summary");
    keyValueRow(
      doc,
      "Scan date",
      `${data.scannedAt.toISOString().replace("T", " ").slice(0, 19)} UTC`,
    );
    keyValueRow(
      doc,
      "Generated",
      `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
    );
    keyValueRow(doc, "Overall score", `${data.score}%`);
    keyValueRow(doc, "Rules evaluated", String(data.total));
    keyValueRow(doc, "Passed", String(data.passed), GREEN);
    keyValueRow(doc, "Failed", String(data.failed), data.failed > 0 ? RED : TEXT);
    keyValueRow(doc, "Errors", String(data.errors), data.errors > 0 ? AMBER_DARK : TEXT);

    // -- Chart --------------------------------------------------------------
    doc.moveDown(1);
    ensureSpace(doc, R_OUTER * 2 + 90);
    sectionHeading(doc, "Result distribution");
    drawDoughnut(doc, data);

    drawSummaryStatement(doc, data);

    // -- Findings -----------------------------------------------------------
    const failed = data.results.filter((r) => r.status === "failed");
    const errored = data.results.filter((r) => r.status === "error");

    if (failed.length > 0) {
      sectionHeading(doc, "Failed Rules");
      failed.forEach((rule, index) => drawFailedRule(doc, rule, index + 1));
    }

    if (errored.length > 0) {
      sectionHeading(doc, "Rules That Could Not Be Evaluated");
      errored.forEach((rule, index) => drawErrorRule(doc, rule, index + 1));
    }

    // -- Appendix -----------------------------------------------------------
    drawPassedAppendix(doc, data.results);

    // -- Footers on every buffered page -------------------------------------
    drawFooters(doc);

    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Footer — revisits every buffered page and writes "Page X of Y"
// ---------------------------------------------------------------------------

function drawFooters(doc: Doc): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font("Helvetica").fontSize(8).fillColor(MUTED);
    const footer = `Page ${i - range.start + 1} of ${range.count}`;
    // Point y AT an inside-the-content position: PDFKit's text() treats a
    // y below the page maxY() as overflowing and silently starts a NEW page —
    // which is how footers ended up on their own blank pages before. maxY()-14
    // renders the line comfortably inside the content area.
    doc.text(footer, PAGE_MARGIN, doc.page.maxY() - 14, {
      width: CONTENT_WIDTH,
      align: "right",
      lineBreak: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Filename helper (report plan §1): "Asset-CIS-report-YYYY-MM-DD.pdf", with
// a constant fallback when both names sanitize to empty.
// ---------------------------------------------------------------------------

export function buildReportFilename(assetTitle: string, cisName: string, date: Date): string {
  const asset = sanitizeFilenamePart(assetTitle);
  const cis = sanitizeFilenamePart(cisName);
  const base = [asset, cis].filter(Boolean).join("-") || "asset-cis";
  return `${base}-report-${date.toISOString().slice(0, 10)}.pdf`;
}








