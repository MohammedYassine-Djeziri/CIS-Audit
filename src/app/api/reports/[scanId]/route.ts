import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  ReportDataError,
  buildReportFilename,
  generateComplianceReport,
} from "@/lib/report";
import type { StoredRuleResult } from "@/lib/types";

/**
 * Report download Route Handler (report feature plan §7):
 *
 *   GET /api/reports/[scanId]
 *
 * A Route Handler — not a Server Action — because the response is a binary
 * PDF download; route handlers stream that naturally with proper download
 * headers, without serializing large values through the action protocol.
 *
 * The scanId is the ONLY client input: the authoritative report data (asset,
 * counts, per-rule snapshot) is loaded server-side from the ScanHistory row
 * written at scan time, so browser-side tampering cannot alter a report
 * (report plan §5/§6).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scan ids are uuid(7) strings (see schema). Validate the SHAPE before it
 * reaches the database layer.
 */
function isValidScanId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ scanId: string }> },
) {
  const { scanId } = await params;
  if (!isValidScanId(scanId)) {
    return Response.json({ error: "Invalid scan id." }, { status: 400 });
  }

  const scan = await prisma.scanHistory.findUnique({
    where: { id: scanId },
    include: {
      asset: {
        select: {
          title: true,
          ipAddress: true,
          username: true,
          cis: { select: { name: true } },
        },
      },
    },
  });
  if (!scan) {
    return Response.json({ error: "Scan not found." }, { status: 404 });
  }

  // NOTE (authentication): once auth is implemented, confirm HERE that the
  // current user is allowed to access this asset (report plan §7, step 3).
  // Today this is a single-user internal tool, so no ownership check exists.

  const results = (Array.isArray(scan.results) ? scan.results : []) as unknown as StoredRuleResult[];

  try {
    const pdf = await generateComplianceReport({
      scanId: scan.id,
      scannedAt: scan.scannedAt,
      assetTitle: scan.asset.title,
      ipAddress: scan.asset.ipAddress,
      username: scan.asset.username,
      cisName: scan.asset.cis.name,
      score: scan.score,
      passed: scan.passed,
      failed: scan.failed,
      errors: scan.errors,
      total: scan.total,
      results,
    });

    // Sanitized filename (report plan §1): asset/CIS names are user
    //-controlled, so `Production / Web Server #1` becomes
    // `Production-Web-Server-1` — no path separators, no header injection.
    const filename = buildReportFilename(scan.asset.title, scan.asset.cis.name, scan.scannedAt);

    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof ReportDataError) {
      return Response.json({ error: err.message }, { status: 500 });
    }
    console.error("[report] generation failed:", err);
    return Response.json({ error: "Report generation failed." }, { status: 500 });
  }
}
