"use server";

import { prisma } from "@/lib/prisma";
import type { HistoryEntry } from "@/lib/types";

/**
 * Scan-history Server Action (plan §4): returns the minimal history shape
 * the UI needs — `{ score, scannedAt }[]` — newest first.
 */
export async function getHistory(assetId: string): Promise<HistoryEntry[]> {
  const rows = await prisma.scanHistory.findMany({
    where: { assetId },
    orderBy: { scannedAt: "desc" },
  });
  return rows.map((row) => ({
    id: row.id,
    score: row.score,
    scannedAt: row.scannedAt.toISOString(),
  }));
}
