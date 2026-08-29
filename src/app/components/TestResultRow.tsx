"use client";

import Button from "react-bootstrap/Button";
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

/**
 * One live-updating line per test_result event (plan §8, §9, §12).
 *
 * Failed rows get an "Information" button (remediation details) and error
 * rows a "Details" button (why the rule could not be evaluated) — both open
 * the single shared RuleDetailsModal with that result. All results carry the
 * details fields (same shape for every event), so the button visibility is
 * purely a status decision.
 */
export function TestResultRow({
  result,
  onShowDetails,
}: {
  result: TestResult;
  onShowDetails: (result: TestResult) => void;
}) {
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
        {result.status === "failed" && (
          <Button
            variant="outline-danger"
            size="sm"
            aria-label={`View remediation for ${result.rule_id}`}
            title="View finding details and remediation"
            onClick={() => onShowDetails(result)}
          >
            Information
          </Button>
        )}
        {result.status === "error" && (
          <Button
            variant="outline-warning"
            size="sm"
            aria-label={`View error details for ${result.rule_id}`}
            title="View error details and suggested action"
            onClick={() => onShowDetails(result)}
          >
            Details
          </Button>
        )}
      </div>
    </ListGroup.Item>
  );
}