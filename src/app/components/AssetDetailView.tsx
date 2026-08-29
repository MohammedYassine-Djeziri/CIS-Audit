"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Container from "react-bootstrap/Container";
import { useCurrentAsset } from "@/lib/store";
import { getHistory } from "@/lib/actions/history";
import { runScanStream } from "@/lib/scan-client";
import type { AssetSummary, HistoryEntry, ScanEvent } from "@/lib/types";
import { HistoryTable } from "./HistoryTable";
import { ScanButton } from "./ScanButton";
import { PasswordPromptModal } from "./PasswordPromptModal";
import { ScanProgressPanel } from "./ScanProgressPanel";

export interface TestResult {
  index: number;
  rule_id: string;
  title: string;
  severity: string;
  status: "passed" | "failed" | "error";
  error?: string;
}

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

        
          setResults((prev) => [
            ...prev.filter((r) => r.index !== event.index),
            {
              index: event.index,
              rule_id: event.rule_id,
              title: event.title,
              severity: event.severity,
              status:event.status ,
              error: event.error,
            },
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

      await runScanStream(asset.id, password, handleEvent);

      setScanning(false);
      clearPassword(); // password's useful life is over — clear it immediately
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
      />

      <h2 className="h5 mt-4">Scan history</h2>
      <HistoryTable history={history} />

      <PasswordPromptModal
        show={showPasswordModal}
        asset={asset}
        onHide={() => setShowPasswordModal(false)}
        onSubmit={handleScanSubmit}
      />
    </Container>
  );
}
