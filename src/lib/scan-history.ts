import { prisma } from "@/lib/prisma";

/**
 * Internal helper for the scan Route Handler — deliberately NOT a Server
 * Action ("use server"), so it is never exposed as a callable endpoint to
 * the client. Only the scan route calls it directly once a scan completes
 * (plan § build prompt 7).
 */
export async function recordScan(assetId: string, score: number): Promise<void> {
  await prisma.scanHistory.create({ data: { assetId, score } });
}
