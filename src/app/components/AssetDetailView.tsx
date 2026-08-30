"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Container from "react-bootstrap/Container";
import { useCurrentAsset } from "@/lib/store";
import { getHistory } from "@/lib/actions/history";
import { runScanStream } from "@/lib/scan-client";
import type {
  AssetSummary,
  HistoryEntry,
  ScanEvent,
  ScanTestResult as TestResult,
} from "@/lib/types";
import { HistoryTable } from "./HistoryTable";
import { ScanButton } from "./ScanButton";
import { PasswordPromptModal } from "./PasswordPromptModal";
import { ScanProgressPanel } from "./ScanProgressPanel";
import { RuleDetailsModal } from "./RuleDetailsModal";

/** The full per-rule result shape streamed by POST /api/scan (plan §5). */
export type { TestResult };

/**
 * Asset detail view (plan §8, `/assets/[id]`). Owns the live scan state fed
 * by the event stream, the history table, and the password prompt flow.
 */
export function AssetDetailView({
  asset,
  initialHistory,
}: {
  asset: AssetSummary;
  initialHistory: HistoryEntry[];
}) {
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory);
  const [showPasswordModal, setShowPasswordModal] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<TestResult[]>([]);
  const [summary, setSummary] = useState<{
    score: number;
    passed: number;
    failed: number;
    errors: number;
    total: number;
  } | null>(
    null,
  );
  const [scanError, setScanError] = useState<string | null>(null);
  // Server-side id of the completed scan's persisted snapshot (report plan
  // §6). Stored ONLY — the report is generated from the server's snapshot
  // via GET /api/reports/[scanId], never from this component's state, so
  // browser tampering cannot change report contents.
  const [completedScanId, setCompletedScanId] = useState<string | null>(null);
  // The result shown in the rule-details modal — ONE modal for all rows,
  // rendered once below (not one Bootstrap modal per rule).
  const [selectedResult, setSelectedResult] = useState<TestResult | null>(null);

  const setAsset = useCurrentAsset((s) => s.setAsset);
  const clearPassword = useCurrentAsset((s) => s.clearPassword);
  // Keep the store's current asset in sync (setAsset also resets any stale
  // password — its key safety behavior).
  useEffect(() => {
    setAsset(asset);
  }, [asset, setAsset]);

  const refreshHistory = useCallback(async () => {
    setHistory(await getHistory(asset.id));
  }, [asset.id]);

  const handleEvent = useCallback(
    (event: ScanEvent) => {
      switch (event.type) {
        case "status":
          setStage(event.stage);
          if (event.stage === "scanning_started" && typeof event.total === "number") {
            setTotal(event.total);
            setResults([]);
          }
          break;
        case "test_result": {
          // The event carries the FULL details shape (rule number, audit
          // commands, procedure, remediation, execution mode, and — for
          // error results — the sanitized diagnostic/exit code). Same shape
          // for every status, so no conditional state handling is needed.
          const result: TestResult = {
            index: event.index,
            rule_id: event.rule_id,
            number: event.number,
            title: event.title,
            severity: event.severity,
            status: event.status,
            auditCommands: event.auditCommands,
            auditProcedure: event.auditProcedure,
            remediation: event.remediation,
            executionMode: event.executionMode,
            error: event.error,
            errorCategory: event.errorCategory,
            exit_code: event.exit_code,
          };
          setResults((prev) => [
            ...prev.filter((r) => r.index !== event.index),
            result,
          ]);
          break;
        }
        case "complete":
          setSummary({
            score: event.score,
            passed: event.passed,
            failed: event.failed,
            errors: event.errors,
            total: event.total,
          });
          setStage("complete");
          // The server saved the scan snapshot before emitting this event;
          // the id here is what the Generate report button uses (report §6).
          setCompletedScanId(event.scanId ?? null);
          break;
        case "error":
          setScanError(event.message);
          break;
      }
    },
    [],
  );

  const handleScanSubmit = useCallback(
    async (password: string) => {
      setShowPasswordModal(false);
      setScanning(true);
      setStage(null);
      setResults([]);
      setTotal(0);
      setSummary(null);
      setScanError(null);
      // A new scan invalidates the previous scan's report (report plan §4):
      // the button hides until the new scan completes and persists. It also
      // supersedes the rule shown in the details modal.
      setCompletedScanId(null);
      setSelectedResult(null);

      try {
        await runScanStream(asset.id, password, handleEvent);
      } catch (err) {
        // Mid-stream failure (e.g. the reader rejected after a network drop).
        // The stream usually reports these via a typed error event; this
        // backstop covers the cases where the socket itself failed.
        setScanError(err instanceof Error ? err.message : String(err));
      } finally {
        // The password's useful life is over — clear it in EVERY path (also
        // when the scan failed or the stream threw), and never leave the UI
        // stuck in "scanning".
        setScanning(false);
        clearPassword();
      }

      await refreshHistory(); // picks up the new ScanHistory row (if any)
    },
    [asset.id, handleEvent, clearPassword, refreshHistory],
  );

  return (
    <Container className="py-4">
      <p className="mb-2">
        <Link href="/assets" className="text-decoration-none">
          ← All assets
        </Link>
      </p>
      <div className="d-flex justify-content-between align-items-start mb-4 gap-3 flex-wrap">
        <div>
          <h1 className="h3 mb-1">{asset.title}</h1>
          <p className="text-body-secondary font-monospace mb-1">
            {asset.username}@{asset.ipAddress}
          </p>
          <span className="badge text-bg-secondary">{asset.cisName}</span>
        </div>
        <ScanButton onClick={() => setShowPasswordModal(true)} disabled={scanning} />
      </div>

      <ScanProgressPanel
        scanning={scanning}
        stage={stage}
        total={total}
        results={results}
        summary={summary}
        error={scanError}
        completedScanId={completedScanId}
        onShowDetails={setSelectedResult}
      />

      <h2 className="h5 mt-4">Scan history</h2>
      <HistoryTable history={history} />

      <PasswordPromptModal
        show={showPasswordModal}
        asset={asset}
        onHide={() => setShowPasswordModal(false)}
        onSubmit={handleScanSubmit}
      />

      <RuleDetailsModal
        result={selectedResult}
        show={selectedResult !== null}
        onHide={() => setSelectedResult(null)}
      />
    </Container>
  );
}
