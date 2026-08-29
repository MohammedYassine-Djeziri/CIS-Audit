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