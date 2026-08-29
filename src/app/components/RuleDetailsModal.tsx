"use client";

import Alert from "react-bootstrap/Alert";
import Badge from "react-bootstrap/Badge";
import Modal from "react-bootstrap/Modal";
import type { ScanErrorCategory, ScanTestResult, TestStatus } from "@/lib/types";

const STATUS_BADGES: Record<
  TestStatus,
  { label: string; variant: "success" | "danger" | "warning" }
> = {
  passed: { label: "PASS", variant: "success" }, // green: executed, compliant
  failed: { label: "FAIL", variant: "danger" }, // red: executed, finding
  error: { label: "ERROR", variant: "warning" }, // yellow: could not be evaluated
};

const ERROR_CATEGORY_LABELS: Record<ScanErrorCategory, string> = {
  timeout: "Command timed out",
  execution: "Command execution failed",
  channel: "SSH channel error",
};

/**
 * Operational next steps for a rule that could NOT be evaluated. These are
 * deliberately scanner/operational suggestions — the benchmark's CIS
 * remediation does not apply to a scanner execution error (an error is not a
 * finding).
 */
const ERROR_SUGGESTIONS: Record<ScanErrorCategory, string> = {
  timeout:
    "Re-run the scan. If it recurs, check the load on the target host and consider a larger SCAN_COMMAND_TIMEOUT_MS.",
  execution:
    "Check that the audit command exists on the target, that the account has permission to run it as root, and re-run the scan.",
  channel:
    "The SSH connection dropped while the command ran. Check network stability and re-run the scan.",
};

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <h3 className="h6 text-uppercase text-body-secondary mb-1">{heading}</h3>
      {children}
    </div>
  );
}

/**
 * The ONE shared rule-details modal (feature plan Phase 2): opened with the
 * selected result from the scan progress list — one modal instance for all
 * rows, not one Bootstrap modal per rule.
 *
 * - Failed rule → rule information, audit procedure, the ORIGINAL benchmark
 *   commands (never the internally generated `sudo -S -p '' -- /bin/sh -c
 *   '...'` wrapper — and never the password or stdin contents), and the
 *   remediation with preserved line breaks.
 * - Error rule → the same rule information and commands, plus the error
 *   category, sanitized message, exit code, and a suggested operational
 *   action. No CIS remediation here: an error is not a finding.
 */
export function RuleDetailsModal({
  result,
  show,
  onHide,
}: {
  result: ScanTestResult | null;
  show: boolean;
  onHide: () => void;
}) {
  // No result selected → render nothing (the modal is controlled by `show`).
  if (!result) return null;

  const badge = STATUS_BADGES[result.status] ?? STATUS_BADGES.error;
  const isError = result.status === "error";

  return (
    <Modal show={show} onHide={onHide} centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="d-flex align-items-center gap-2 flex-wrap">
          <span className="badge text-bg-light font-monospace">{result.rule_id}</span>
          <span className="fs-6 fw-normal">{result.title}</span>
        </Modal.Title>
      </Modal.Header>

      <Modal.Body>
        <Section heading="Rule information">
          <dl className="row mb-0 small">
            <div className="col-6 col-md-4">
              <dt className="text-body-secondary fw-normal">Rule number</dt>
              <dd className="mb-2 font-monospace">{result.number}</dd>
            </div>
            <div className="col-6 col-md-4">
              <dt className="text-body-secondary fw-normal">Severity</dt>
              <dd className="mb-2">
                <span className="badge text-bg-secondary">{result.severity}</span>
              </dd>
            </div>
            <div className="col-6 col-md-4">
              <dt className="text-body-secondary fw-normal">Status</dt>
              <dd className="mb-2">
                <span className={`badge text-bg-${badge.variant}`}>{badge.label}</span>
              </dd>
            </div>
          </dl>
        </Section>

        {result.auditProcedure && (
          <Section heading="Audit procedure">
            {/* pre-wrap keeps the benchmark's line breaks readable */}
            <div className="small" style={{ whiteSpace: "pre-wrap" }}>
              {result.auditProcedure}
            </div>
          </Section>
        )}

        {result.auditCommands.length > 0 && (
          <Section heading="Executed command">
            {/* One block per original benchmark command, in execution order.
                The internal sudo/root-shell wrapper is deliberately NOT shown. */}
            {result.auditCommands.map((cmd, i) => (
              <pre
                key={`${result.rule_id}-cmd-${i}`}
                className="bg-body-secondary border rounded p-2 mb-2 small"
              >
                <code>{cmd}</code>
              </pre>
            ))}
            <div className="small text-body-secondary">
              Execution mode:{" "}
              {result.executionMode === "root" ? "directly as root" : "root through sudo"}
            </div>
          </Section>
        )}

        {isError ? (
          <Section heading="Error details">
            <Alert variant="warning" className="small mb-2">
              The audit command could not be evaluated — this is not a compliance finding.
              {result.errorCategory && (
                <>
                  <br />
                  <strong>Category:</strong> {ERROR_CATEGORY_LABELS[result.errorCategory]}
                </>
              )}
              {result.error && (
                <>
                  <br />
                  <strong>Reason:</strong> {result.error}
                </>
              )}
              {typeof result.exit_code === "number" && result.exit_code >= 0 && (
                <>
                  <br />
                  <strong>Exit code:</strong> {result.exit_code}
                </>
              )}
            </Alert>
            {result.errorCategory && (
              <div className="small">
                <strong>Suggested action:</strong> {ERROR_SUGGESTIONS[result.errorCategory]}
              </div>
            )}
            <div className="small text-body-secondary fst-italic mt-2">
              The benchmark remediation does not apply here — it only addresses real findings, not
              scanner execution problems.
            </div>
          </Section>
        ) : (
          result.remediation && (
            <Section heading="Remediation">
              {/* pre-wrap keeps longer remediation procedures readable */}
              <div className="small" style={{ whiteSpace: "pre-wrap" }}>
                {result.remediation}
              </div>
            </Section>
          )
        )}
      </Modal.Body>

      <Modal.Footer>
        <Badge bg="light" text="dark" className="fw-normal">
          #{result.index}
        </Badge>
      </Modal.Footer>
    </Modal>
  );
}
