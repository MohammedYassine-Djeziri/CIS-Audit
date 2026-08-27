"use client";

import { ProgressBar } from "react-bootstrap";
import type { HistoryEntry } from "@/lib/types";

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
      <td>{new Date(entry.scannedAt).toLocaleString()}</td>
    </tr>
  );
}