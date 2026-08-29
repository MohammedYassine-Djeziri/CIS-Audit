"use client";

import ProgressBar from "react-bootstrap/ProgressBar";

/**
 * Final score, shown once the `complete` event arrives (plan §8, §9). The
 * history table refresh itself is triggered by the detail view when this
 * event is received. Errors are reported separately — they are never counted
 * as passed.
 */
export function ScanSummary({
  score,
  passed,
  failed,
  errors,
  total,
  error,
}: {
  score: number;
  passed: number;
  failed: number;
  errors: number;
  total: number;
  error?: string | null;
}) {
  const variant = score >= 80 ? "success" : score >= 50 ? "warning" : "danger";
  return (
    <div className="mt-2">
      <h3 className="h5 mb-2">
        Score: <span className={`text-${variant}`}>{score}%</span>
        <span className="text-body-secondary fw-normal fs-6 ms-2">
          ({passed}/{total} passed, {failed} failed
          {errors > 0 ? `, ${errors} error${errors === 1 ? "" : "s"}` : ""})
        </span>
      </h3>
      <ProgressBar now={score} variant={variant} style={{ height: "1.25rem" }} />
      {error && <p className="text-body-secondary small mt-2 mb-0">{error}</p>}
    </div>
  );
}