"use server";

import { prisma } from "@/lib/prisma";
import type { HistoryEntry } from "@/lib/types";

/**
 * Scan-history Server Action (plan §4, extended by report plan §12): returns
 * the minimal history shape the UI needs — newest first, now including the
 * detailed counts and a flag for whether the row carries a full report
 * snapshot (pre-snapshot rows don't).
 */
export async function getHistory(assetId: string): Promise<HistoryEntry[]> {
  const rows = await prisma.scanHistory.findMany({
    where: { assetId },
    orderBy: { scannedAt: "desc" },
  });
  return rows.map((row) => {
    // Scans recorded before snapshot persistence have results "[]"; those
    // cannot produce a detailed report, so no Download is offered for them.
    const hasDetails = Array.isArray(row.results) && row.results.length > 0;
    return {
      id: row.id,
      score: row.score,
      passed: row.passed,
      failed: row.failed,
      errors: row.errors,
      total: row.total,
      hasDetails,
      scannedAt: row.scannedAt.toISOString(),
    };
  });
}
