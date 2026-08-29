import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { StoredRuleResult } from "@/lib/types";

/**
 * Internal helper for the scan Route Handler — deliberately NOT a Server
 * Action ("use server"), so it is never exposed as a callable endpoint to
 * the client. Only the scan route calls it directly once a scan completes.
 *
 * Persists the COMPLETE scan snapshot (report feature plan §9/§10): score,
 * detailed counts, and the per-rule result array — the server's own trusted
 * data, never anything the browser supplied. This row is the authoritative
 * source for report generation (GET /api/reports/[scanId]); the browser only
 * ever receives the returned snapshot id.
 */
export async function recordScan(entry: {
  assetId: string;
  score: number;
  passed: number;
  failed: number;
  errors: number;
  total: number;
  results: StoredRuleResult[];
}): Promise<{ id: string }> {
  const saved = await prisma.scanHistory.create({
    data: {
      assetId: entry.assetId,
      score: entry.score,
      passed: entry.passed,
      failed: entry.failed,
      errors: entry.errors,
      total: entry.total,
      results: entry.results as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return saved;
}
