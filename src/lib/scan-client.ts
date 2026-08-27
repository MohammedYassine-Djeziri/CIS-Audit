import type { ScanEvent } from "./types";

/**
 * Client-side consumer for the streamed POST /api/scan response (plan §5,
 * build prompt 14). Opens the fetch, reads the body incrementally with
 * response.body.getReader(), and dispatches every complete JSON line to
 * `onEvent`. No extra protocol or library — one HTTP connection, server →
 * client only.
 */
export async function runScanStream(
  assetId: string,
  password: string,
  onEvent: (event: ScanEvent) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId, password }),
    });
  } catch (err) {
    onEvent({
      type: "error",
      stage: "scan_failed",
      message: `Could not reach the scanner: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  if (!response.ok || !response.body) {
    let message = `Scan request failed (HTTP ${response.status}).`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      // non-JSON error body — keep the generic message
    }
    onEvent({ type: "error", stage: "scan_failed", message });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      onEvent(JSON.parse(line) as ScanEvent);
    } catch {
      // Ignore any malformed partial line — never crash the UI mid-scan.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the trailing partial line buffered
    for (const line of lines) processLine(line);
  }
  if (buffer) processLine(buffer); // flush whatever remains
}
