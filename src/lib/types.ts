/**
 * Shared types for the CIS auditing app (plan §3 and §5).
 */

/**
 * The structured, machine-readable "how to judge the audit command output"
 * field. Every rule in any CIS/STIG benchmark gets exactly one of these
 * before it can be used by the scanner (see the seed script).
 */
export type CheckType =
  | { type: "output_empty" } // pass if stdout is empty
  | { type: "output_contains"; value: string } // pass if stdout includes this substring
  | { type: "output_equals"; value: string } // pass if trimmed stdout === value
  | { type: "output_matches_regex"; pattern: string } // pass if regex matches stdout
  | { type: "numeric_gte"; value: number } // pass if a number extracted from stdout >= value
  | { type: "manual" }; // not automatable — never executed by the scanner

/**
 * One rule's evaluation result (plan §9): the audit was either executed and
 * confirmed compliance ("passed"), executed and confirmed a finding
 * ("failed"), or could NOT be evaluated reliably ("error" — sudo failure,
 * permission denied, command not found, timeout, SSH channel error). An
 * execution problem must never be presented as a confirmed compliance
 * failure, and errors are reported separately in the final summary.
 */
export type TestStatus = "passed" | "failed" | "error";

/**
 * Broad failure class of a status "error" result, used by the UI to suggest a
 * sensible operational action (never a CIS remediation — that only applies to
 * real findings, not to scanner execution problems):
 *   - "timeout":   the audit command exceeded the per-command time limit.
 *   - "execution": sudo failure, permission denied, command not found, …
 *   - "channel":   SSH channel/connection error while the command ran.
 */
export type ScanErrorCategory = "timeout" | "execution" | "channel";

/**
 * The full per-rule payload of a `test_result` event (plan §5, extended for
 * the rule-details modal). The same shape is ALWAYS sent for passed, failed,
 * and error results — one shape keeps client state handling and report
 * generation simple, and CIS templates are small enough that the extra
 * response size is not a concern.
 *
 * Security invariants (plan §12):
 *  - `auditCommands` holds the ORIGINAL benchmark commands only — never the
 *    internally generated `sudo -S -p '' -- /bin/sh -c '...'` wrapper.
 *  - No command stdout/stderr is streamed (it can contain sensitive system
 *    data such as /etc/shadow contents).
 *  - `error` (error results only) is a short, sanitized, truncated
 *    diagnostic; the SSH password is never present anywhere in the payload.
 */
export interface ScanTestResult {
  index: number;
  rule_id: string;
  number: string;
  title: string;
  severity: string;
  status: TestStatus;
  /** Original benchmark audit commands, one entry per command, run in order. */
  auditCommands: string[];
  /** Human-readable audit text from the benchmark, shown in the UI. */
  auditProcedure: string;
  /** Benchmark remediation text — displayed for failed rules, never as the fix for scanner errors. */
  remediation: string;
  /**
   * How the audit commands were executed on the target: directly when
   * connected as root, otherwise elevated through sudo (shown as a note in
   * the details modal).
   */
  executionMode: "root" | "sudo";
  /** Short diagnostic for status "error" — never contains secrets or full output. */
  error?: string;
  /** Broad failure class for status "error" (see ScanErrorCategory). */
  errorCategory?: ScanErrorCategory;
  /** Exit code of the audit command that failed to execute (error results). */
  exit_code?: number;
}

/**
 * One rule of a CIS/STIG-style benchmark, in the generalized shape of plan §3. */
export interface CisTest {
  rule_id: string;
  number: string;
  severity: string; // "CATI" | "CATII" | "CATIII", or whatever the source benchmark uses
  automated: boolean;
  title: string;
  cci?: string;
  audit_command: string[]; // one or more shell commands, run in order
  audit_procedure: string; // human-readable audit text, shown in the UI for context
  remediation: string;
  check: CheckType;
}

/**
 * One JSON object per line/event of the streamed POST /api/scan response
 * (plan §5). The client reads the body incrementally and dispatches on
 * `type`.
 */
export type ScanEvent =
  | {
      type: "status";
      stage:
        | "preparing"
        | "testing_connectivity"
        | "connected"
        | "verifying_privileges"
        | "scanning_started";
      total?: number;
    }
  | {
      type: "error";
      stage: "invalid_template" | "connection_failed" | "privilege_failed" | "scan_failed";
      message: string;
    }
  | {
      type: "test_result";
    } & ScanTestResult
  | {
      type: "complete";
      /**
       * Database id of the persisted scan snapshot (plan §6). The client
       * stores ONLY this id and uses it to request the report — report data
       * itself is loaded server-side from the trusted snapshot, so browser
       * tampering cannot change what a report says. Optional in the type
       * because a snapshot write failure must not break the scan stream.
       */
      scanId?: string;
      score: number;
      passed: number;
      failed: number;
      errors: number;
      total: number;
    };

/**
 * Command-level result retained for reports (plan §13): the ORIGINAL
 * benchmark command (never the internal `sudo -S -p '' -- /bin/sh -c '...'`
 * wrapper) alongside its sanitized, truncated stdout/stderr and exit code.
 * The SSH password is never present — outputs are redacted and scrubbed
 * before they are stored (lib/sanitize.ts, prepareReportEvidence).
 */
export interface AuditCommandExecution {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * One rule of the SERVER-SIDE scan snapshot persisted in
 * `ScanHistory.results` (plan §9/§14): the authoritative, immutable record
 * of what was executed and found during one specific scan. This is the only
 * source report generation trusts — never client state. It carries the
 * remediation/audit text AS IT EXISTED at scan time, so later edits to the
 * CIS template cannot alter a historical report.
 *
 * Command evidence (`executions`) is stored here for reports only — it is
 * deliberately NOT part of the live `test_result` stream, whose payloads
 * (ScanTestResult) never contain command output.
 */
export interface StoredRuleResult {
  rule_id: string;
  number: string;
  title: string;
  severity: string;
  status: TestStatus;
  /** Original benchmark audit commands, in execution order. */
  auditCommands: string[];
  auditProcedure: string;
  /** Benchmark remediation snapshot at scan time (failed rules only in reports). */
  remediation: string;
  /** Sanitized per-command evidence (stdout/stderr/exit code). */
  executions: AuditCommandExecution[];
  /** Short sanitized diagnostic for status "error" results. */
  error?: string;
  errorCategory?: ScanErrorCategory;
  /** Exit code of the audit command that failed to execute (error results). */
  exit_code?: number;
  /** How the commands were executed ("root" directly, or via sudo). */
  executionMode: "root" | "sudo";
}

/**
 * Plain, serializable shapes the UI consumes (no Prisma models cross the
 * RSC/client boundary).
 */
export interface AssetSummary {
  id: string;
  title: string;
  ipAddress: string;
  /** SSH account used to connect when scanning this asset. */
  username: string;
  cisId: string;
  cisName: string;
  createdAt: string; // ISO string
}

export interface HistoryEntry {
  id: string;
  score: number;
  /** Detailed counts from the persisted snapshot (plan §12). */
  passed: number;
  failed: number;
  errors: number;
  total: number;
  /**
   * Whether the row carries a full result snapshot. Scans recorded before
   * snapshot persistence (and, defensively, any row with an empty results
   * array) cannot produce a detailed report — no Download is offered.
   */
  hasDetails: boolean;
  scannedAt: string; // ISO string
}