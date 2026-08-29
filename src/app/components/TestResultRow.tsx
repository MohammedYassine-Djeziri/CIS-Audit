"use client";

import ListGroup from "react-bootstrap/ListGroup";
import type { TestResult } from "./AssetDetailView";

const STATUS_BADGES: Record<
  TestResult["status"],
  { label: string; variant: "success" | "danger" | "warning" }
> = {
  passed: { label: "PASS", variant: "success" }, // green: executed, compliant
  failed: { label: "FAIL", variant: "danger" }, // red: executed, finding
  error: { label: "ERROR", variant: "warning" }, // yellow: could not be evaluated
};

/** One live-updating line per test_result event (plan §8, §9, §12). */
export function TestResultRow({ result }: { result: TestResult }) {
  const badge = STATUS_BADGES[result.status] ?? STATUS_BADGES.error;
  return (
    <ListGroup.Item className="d-flex justify-content-between align-items-start gap-2 py-2 px-2">
      <div className="me-2">
        <span className="badge text-bg-light font-monospace me-2">{result.rule_id}</span>
        <small className="text-body-secondary">#{result.index}</small>
        <div className="small">{result.title}</div>
        {result.error && (
          <div className="small text-body-secondary fst-italic">{result.error}</div>
        )}
      </div>
      <div className="text-nowrap d-flex align-items-center gap-2">
        <span className={`badge text-bg-${badge.variant}`}>{badge.label}</span>
        <span className="badge text-bg-secondary">{result.severity}</span>
      </div>
    </ListGroup.Item>
  );
}