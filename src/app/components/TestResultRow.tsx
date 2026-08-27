"use client";

import ListGroup from "react-bootstrap/ListGroup";
import type { TestResult } from "./AssetDetailView";

/** One live-updating line per test_result event (plan §8). */
export function TestResultRow({ result }: { result: TestResult }) {
  return (
    <ListGroup.Item className="d-flex justify-content-between align-items-start gap-2 py-2 px-2">
      <div className="me-2">
        <span className="badge text-bg-light font-monospace me-2">{result.rule_id}</span>
        <small className="text-body-secondary">#{result.index}</small>
        <div className="small">{result.title}</div>
      </div>
      <div className="text-nowrap d-flex align-items-center gap-2">
        <span className={`badge text-bg-${result.passed ? "success" : "danger"}`}>
          {result.passed ? "PASS" : "FAIL"}
        </span>
        <span className="badge text-bg-secondary">{result.severity}</span>
      </div>
    </ListGroup.Item>
  );
}