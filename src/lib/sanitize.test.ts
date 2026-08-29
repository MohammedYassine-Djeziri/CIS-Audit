import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DIAGNOSTIC_LENGTH, redactSecret, sanitizeDiagnostic, truncateText } from "./sanitize";

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
