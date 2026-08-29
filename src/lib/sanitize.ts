/**
 * Safeguards for anything the scanner/scan route streams to the client
 * (feature plan Phase 1, step 4). Two simple, testable primitives:
 *
 *  - redactSecret: makes sure the SSH password can never leak into a
 *    streamed diagnostic, log line, or error message, even by accident.
 *  - truncateText: bounds the size of any streamed text so a pathological
 *    stderr (or a huge output buffer) cannot balloon the response.
 *
 * Command stdout/stderr are never streamed at all — these helpers apply to
 * the SHORT diagnostics that accompany status "error" results.
 */

/** Hard upper bound for any single streamed diagnostic message. */
export const MAX_DIAGNOSTIC_LENGTH = 300;

/**
 * Replaces every occurrence of `secret` in `text` with "[redacted]".
 * Cheap and allocation-safe for short strings; a no-op for an empty secret.
 */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

/**
 * Trims `text` and truncates it to `maxLength` characters, appending a short
 * marker when anything was cut so the reader knows the message is partial.
 */
export function truncateText(text: string, maxLength: number = MAX_DIAGNOSTIC_LENGTH): string {
  const clean = text.trim();
  if (clean.length <= maxLength) return clean;
  const omitted = clean.length - maxLength;
  return `${clean.slice(0, maxLength)}… [truncated, ${omitted} more character${omitted === 1 ? "" : "s"}]`;
}

/**
 * The one sanitizer for scanner-produced diagnostics: redact the SSH secret,
 * then hard-bound the length. Used for every `error` message that leaves the
 * server (plan §12 — never stream the password or full command output).
 */
export function sanitizeDiagnostic(message: string, secret: string): string {
  return truncateText(redactSecret(message, secret));
}

// ---------------------------------------------------------------------------
// Report/evidence safeguards (report feature plan §1–§3, §10, §13)
// ---------------------------------------------------------------------------

/** Hard upper bound for one rule's command output stored/shown as evidence. */
export const MAX_EVIDENCE_LENGTH = 16_000;

/**
 * Prepares raw command output for PERSISTENCE and REPORT display (report
 * plan §3, §10, §13). This never touches compliance evaluation — it runs
 * only on evidence text just before it is stored in the scan snapshot or
 * rendered into a report:
 *
 *  - strips ANSI terminal formatting (colors/cursor codes),
 *  - strips control characters while PRESERVING tabs and newlines,
 *  - redacts the SSH secret defensively (`secret`),
 *  - hard-caps the length with an explicit "[Output truncated]" marker.
 *
 * Legitimate shell characters in audit commands (`$`, `'`, `"`, `|`, …) are
 * deliberately left untouched — they are part of how to reproduce a finding.
 */
export function prepareReportEvidence(value: string, secret = ""): string {
  const redacted = redactSecret(value, secret);
  const cleaned = redacted
    // Remove ANSI escape sequences (CSI ... final byte).
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    // Remove other control characters, but keep tab (\t), LF (\n), CR (\r).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  if (cleaned.length <= MAX_EVIDENCE_LENGTH) {
    return cleaned;
  }
  const omitted = cleaned.length - MAX_EVIDENCE_LENGTH;
  return `${cleaned.slice(0, MAX_EVIDENCE_LENGTH)}\n\n[Output truncated — ${omitted} more character${omitted === 1 ? "" : "s"} not shown]`;
}

/**
 * Makes one user-controlled string safe for use INSIDE a downloaded report
 * filename and the `Content-Disposition` header (report plan §1):
 *
 *  - removes control characters (blocks header injection via line breaks),
 *  - replaces filesystem-unsafe characters (`<>:"/\|?*` and `#`) with `-`,
 *  - collapses whitespace/created dash runs into single dashes,
 *  - trims leading/trailing dots (hidden files, trailing-dot quirks),
 *  - caps the length.
 *
 * "Production / Web Server #1" → "Production-Web-Server-1". The caller
 * falls back to a constant when the result is empty.
 */
export function sanitizeFilenamePart(value: string): string {
  return (
    value
      .normalize("NFKD")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[<>:"/\\|?*#]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 80)
  );
}