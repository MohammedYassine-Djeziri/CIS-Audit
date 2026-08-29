"use client";

import Table from "react-bootstrap/Table";
import type { HistoryEntry } from "@/lib/types";
import { HistoryRow } from "./HistoryRow";

/** Score history table (plan §8) — empty state when no scans yet. */
export function HistoryTable({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) {
    return (
      <p className="text-body-secondary">
        No scan history yet — run a scan and its score will appear here.
      </p>
    );
  }

  return (
    <Table striped hover responsive>
      <thead>
        <tr>
          <th style={{ width: "10rem" }}>Score</th>
          <th className="text-center">Passed</th>
          <th className="text-center">Failed</th>
          <th className="text-center">Errors</th>
          <th>Scanned at</th>
          <th>Report</th>
        </tr>
      </thead>
      <tbody>
        {history.map((entry) => (
          <HistoryRow key={entry.id} entry={entry} />
        ))}
      </tbody>
    </Table>
  );
}