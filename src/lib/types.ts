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

/** One rule of a CIS/STIG-style benchmark, in the generalized shape of plan §3. */
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
      stage: "preparing" | "testing_connectivity" | "connected" | "scanning_started";
      total?: number;
    }
  | { type: "error"; stage: "connection_failed" | "scan_failed"; message: string }
  | {
      type: "test_result";
      index: number;
      rule_id: string;
      title: string;
      severity: string;
      passed: boolean;
    }
  | { type: "complete"; score: number; passed: number; total: number };

/**
 * Plain, serializable shapes the UI consumes (no Prisma models cross the
 * RSC/client boundary).
 */
export interface AssetSummary {
  id: string;
  title: string;
  ipAddress: string;
  cisId: string;
  cisName: string;
  createdAt: string; // ISO string
}

export interface HistoryEntry {
  id: string;
  score: number;
  scannedAt: string; // ISO string
}