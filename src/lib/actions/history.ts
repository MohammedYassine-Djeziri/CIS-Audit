"use server";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { HistoryEntry } from "@/lib/types";

/**
 * Scan-history Server Action (plan §4, extended by report plan §12): returns
 * the minimal history shape the UI needs — newest first, detailed counts, and
 * a flag for whether the row carries a full report snapshot (pre-snapshot
 * rows don't).
 *
 * The listing NEVER fetches the persisted `results` column: a snapshot can be
 * large (every rule's commands, remediation text, and sanitized evidence), and
 * the UI only needs to know WHETHER the snapshot exists. `hasDetails` is
 * computed by a lightweight aggregate query instead, so scrolling through an
 * asset's history never drags the blobs over the network.
 */
export async function getHistory(assetId: string): Promise<HistoryEntry[]> {
  const rows = await prisma.scanHistory.findMany({
    where: { assetId },
    orderBy: { scannedAt: "desc" },
    select: {
      id: true,
      score: true,
      passed: true,
      failed: true,
      errors: true,
      total: true,
      scannedAt: true,
    },
  });

  // Which rows carry a non-empty results snapshot? Prisma cannot filter JSON
  // array length in a portable findMany, so use a targeted raw query that
  // only reads each row's id. The COALESCE + ::jsonb cast keeps legacy or
  // null values (string-encoded "[]" from pre-snapshot rows) from throwing.
  const withSnapshot = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT h."id"
    FROM "ScanHistory" h
    WHERE h."assetId" = ${assetId}
      AND jsonb_array_length(COALESCE(h."results", '[]')::jsonb) > 0
  `);
  const idsWithDetails = new Set(withSnapshot.map((r) => r.id));

  return rows.map((row) => ({
    id: row.id,
    score: row.score,
    passed: row.passed,
    failed: row.failed,
    errors: row.errors,
    total: row.total,
    hasDetails: idsWithDetails.has(row.id),
    scannedAt: row.scannedAt.toISOString(),
  }));
}
