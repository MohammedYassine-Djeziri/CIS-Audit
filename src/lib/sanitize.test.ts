import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DIAGNOSTIC_LENGTH,
  redactSecret,
  sanitizeDiagnostic,
  truncateText,
  sanitizeFilenamePart,
  prepareReportEvidence,
  MAX_EVIDENCE_LENGTH,
} from "./sanitize";

test("redactSecret replaces every occurrence of the secret", () => {
  assert.equal(redactSecret("sudo: s3cret is wrong", "s3cret"), "sudo: [redacted] is wrong");
  assert.equal(redactSecret("a s3cret b s3cret c", "s3cret"), "a [redacted] b [redacted] c");
});

test("redactSecret is a no-op for an empty secret", () => {
  assert.equal(redactSecret("nothing to hide", ""), "nothing to hide");
});

test("redactSecret leaves unrelated text untouched", () => {
  assert.equal(redactSecret("Command not found (exit 127).", "hunter2"), "Command not found (exit 127).");
});

test("truncateText keeps short text intact and trims whitespace", () => {
  assert.equal(truncateText("  short  "), "short");
});

test("truncateText truncates long text with an explicit marker", () => {
  const long = "x".repeat(MAX_DIAGNOSTIC_LENGTH + 25);
  const out = truncateText(long);
  assert.ok(out.startsWith("x".repeat(MAX_DIAGNOSTIC_LENGTH)));
  assert.ok(out.includes("[truncated, 25 more characters]"));
  assert.ok(out.length <= MAX_DIAGNOSTIC_LENGTH + 40);
});

test("truncateText honors a custom limit", () => {
  assert.equal(truncateText("abcdefghij", 4), "abcd… [truncated, 6 more characters]");
});

test("sanitizeDiagnostic redacts the secret first, then bounds the length", () => {
  const password = "p".repeat(10);
  const message = `${"y".repeat(200)} ${password} ${"z".repeat(400)}`;
  const out = sanitizeDiagnostic(message, password);
  assert.ok(!out.includes(password)); // the secret never survives
  assert.ok(out.includes("[redacted]"));
  assert.ok(out.includes("[truncated"));
});

// --- sanitizeFilenamePart (report plan §1) ---------------------------------

test("sanitizeFilenamePart removes path separators and unsafe characters", () => {
  assert.equal(sanitizeFilenamePart("Production / Web Server #1"), "Production-Web-Server-1");
  assert.equal(sanitizeFilenamePart('a<b>c:d"e|f?g*h'), "a-b-c-d-e-f-g-h");
  assert.equal(sanitizeFilenamePart("back\\slash"), "back-slash");
});

test("sanitizeFilenamePart strips control characters (header-injection guard)", () => {
  // A newline in Content-Disposition would break/smuggle headers.
  const hostile = "server\nContent-Type: text/html";
  const out = sanitizeFilenamePart(hostile);
  assert.ok(!out.includes("\n"));
  assert.ok(!out.includes("\r"));
  assert.equal(out, "serverContent-Type-text-html");
});

test("sanitizeFilenamePart collapses whitespace and dash runs, trims dots", () => {
  assert.equal(sanitizeFilenamePart("  spaced   out  "), "spaced-out");
  assert.equal(sanitizeFilenamePart("a---b"), "a-b");
  assert.equal(sanitizeFilenamePart("..hidden.."), "hidden");
});

test("sanitizeFilenamePart caps the length at 80 characters", () => {
  assert.ok(sanitizeFilenamePart("x".repeat(300)).length <= 80);
});

test("sanitizeFilenamePart returns empty string for fully-unsafe input", () => {
  // Caller is responsible for the fallback (e.g. "asset").
  assert.equal(sanitizeFilenamePart("///***"), "");
});

// --- prepareReportEvidence (report plan §3/§10/§13) ------------------------

test("prepareReportEvidence strips ANSI escape sequences", () => {
  assert.equal(prepareReportEvidence("\u001B[31mred\u001B[0m text"), "red text");
  assert.equal(prepareReportEvidence("\u001B[1;32mgreen\u001B[39m"), "green");
});

test("prepareReportEvidence removes control chars but keeps tabs and newlines", () => {
  const out = prepareReportEvidence("col1\tcol2\nline2\u0007bell\u0000null");
  assert.ok(out.includes("col1\tcol2\nline2"));
  assert.ok(!out.includes("\u0007"));
  assert.ok(!out.includes("\u0000"));
});

test("prepareReportEvidence redacts the SSH password defensively", () => {
  const out = prepareReportEvidence("leaked-password: s3cret!", "s3cret!");
  assert.ok(!out.includes("s3cret!"));
  assert.ok(out.includes("[redacted]"));
});

test("prepareReportEvidence truncates very large output with a marker", () => {
  const out = prepareReportEvidence("y".repeat(MAX_EVIDENCE_LENGTH + 5000));
  assert.ok(out.startsWith("y".repeat(MAX_EVIDENCE_LENGTH)));
  assert.ok(out.includes("[Output truncated"));
  assert.ok(out.length <= MAX_EVIDENCE_LENGTH + 100);
});

test("prepareReportEvidence leaves short clean output untouched", () => {
  assert.equal(prepareReportEvidence("test-account\nlegacy-account"), "test-account\nlegacy-account");
});

