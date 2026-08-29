"use client";

import Button from "react-bootstrap/Button";
import { ProgressBar } from "react-bootstrap";
import type { HistoryEntry } from "@/lib/types";

/**
 * One scan-history row (plan §8, extended by report plan §12): score, the
 * detailed counts from the persisted snapshot, and — when the snapshot
 * carries full results — a Download link that re-generates the report for
 * that exact historical scan from the server-side data.
 */
export function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const variant = entry.score >= 80 ? "success" : entry.score >= 50 ? "warning" : "danger";
  return (
    <tr>
      <td>
        <div className="d-flex align-items-center gap-2" style={{ minWidth: "8rem" }}>
          <span className={`text-${variant} fw-semibold`}>{entry.score}%</span>
          <ProgressBar now={entry.score} variant={variant} style={{ width: "5rem" }} />
        </div>
      </td>
      <td className="text-center text-success">{entry.passed}</td>
      <td className="text-center text-danger">{entry.failed}</td>
      <td className="text-center text-warning">{entry.errors}</td>
      <td>{new Date(entry.scannedAt).toLocaleString()}</td>
      <td>
        {entry.hasDetails ? (
          <Button
            variant="outline-primary"
            size="sm"
            href={`/api/reports/${encodeURIComponent(entry.id)}`}
          >
            Download
          </Button>
        ) : (
          <span className="text-body-secondary small">—</span>
        )}
      </td>
    </tr>
  );
}
