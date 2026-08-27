"use client";

import Alert from "react-bootstrap/Alert";
import ProgressBar from "react-bootstrap/ProgressBar";
import type { TestResult } from "./AssetDetailView";
import { TestResultRow } from "./TestResultRow";
import { ScanSummary } from "./ScanSummary";

const STAGE_LABELS: Record<string, string> = {
  preparing: "Preparing scan…",
  testing_connectivity: "Testing connectivity…",
  connected: "Connected — starting tests…",
  scanning_started: "Running tests…",
  complete: "Scan complete",
};

/**
 * Live scan progress (plan §8): shows the current stage from the event
 * stream, a per-test list as test_result events arrive, the final summary
 * on `complete`, and connection/command errors.
 */
export function ScanProgressPanel({
  scanning,
  stage,
  total,
  results,
  summary,
  error,
}: {
  scanning: boolean;
  stage: string | null;
  total: number;
  results: TestResult[];
  summary: { score: number; passed: number; total: number } | null;
  error: string | null;
}) {
  if (!scanning && !summary && !error) return null; // nothing to show yet

  return (
    <div className="border rounded p-3 mb-4">
      {error && (
        <Alert variant="danger" className="mb-2">
          <strong>Scan failed:</strong> {error}
        </Alert>
      )}

      {stage && !summary && (
        <div className="mb-3">
          <div className="d-flex justify-content-between mb-1">
            <span>{STAGE_LABELS[stage] ?? stage}</span>
            {total > 0 && (
              <span className="text-body-secondary">
                {results.length}/{total} tests
              </span>
            )}
          </div>
          {total > 0 && (
            <ProgressBar
              animated={scanning}
              now={total > 0 ? (results.length / total) * 100 : 0}
              variant="info"
            />
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="list-group list-group-flush" style={{ maxHeight: "24rem", overflowY: "auto" }}>
          {results.map((result) => (
            <TestResultRow key={result.index} result={result} />
          ))}
        </div>
      )}

      {summary && (
        <ScanSummary
          score={summary.score}
          passed={summary.passed}
          total={summary.total}
          error={error}
        />
      )}
    </div>
  );
}