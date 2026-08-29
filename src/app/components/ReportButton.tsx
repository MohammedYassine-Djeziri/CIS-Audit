"use client";

import { useCallback, useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";

/**
 * "Generate report" button (report feature plan §4).
 *
 * - Rendered ONLY after a completed scan (the parent passes the scanId from
 *   the `complete` event) — never for failed/incomplete scans.
 * - Shows "Generating report…" while the download is in flight and disables
 *   itself, so a double-click cannot fire two requests.
 * - The scanId is the only data it sends — report content is loaded
 *   server-side from the persisted snapshot (report plan §5/§6).
 * - On failure it shows a clear generation error instead of a silent no-op.
 *
 * The PDF is fetched as a blob (rather than a plain `window.location.href`
 * navigation) so HTTP/Network errors can be surfaced in the UI and the
 * loading state is meaningful; the file is then handed to the browser's
 * download mechanism via a temporary object URL.
 */
export function ReportButton({ scanId }: { scanId: string }) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateReport = useCallback(async () => {
    if (generating) return; // duplicate-click guard
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(scanId)}`);
      if (!response.ok) {
        let message = `Report generation failed (HTTP ${response.status}).`;
        try {
          const data = await response.json();
          if (data?.error) message = data.error;
        } catch {
          // non-JSON error body — keep the generic message
        }
        setError(message);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      // Prefer the server's Content-Disposition filename when the browser
      // exposes it; fall back to a safe generic name.
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      link.download = match?.[1] ?? `compliance-report-${scanId}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        `Could not generate the report: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setGenerating(false);
    }
  }, [generating, scanId]);

  return (
    <div className="mt-3">
      <Button variant="primary" onClick={generateReport} disabled={generating}>
        {generating ? "Generating report…" : "Generate report"}
      </Button>
      {error && (
        <Alert variant="danger" className="mt-2 mb-0 small">
          <strong>Report error:</strong> {error}
        </Alert>
      )}
    </div>
  );
}
