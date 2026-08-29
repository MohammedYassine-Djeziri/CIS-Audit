import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CisContentError, parseCisContent } from "@/lib/cis-parser";
import { scanner } from "@/lib/scanner";
import { scanConfig } from "@/lib/scan-config";
import { recordScan } from "@/lib/scan-history";
import type { ScanEvent } from "@/lib/types";

/**
 * The one streamed Route Handler (plan §5): POST /api/scan
 *
 * Body: { assetId, password }. Runs the entire scan pipeline — fetch the
 * asset's CIS template, VALIDATE it with parseCisContent (the app's one and
 * only schema validation point, run first, before any network I/O), then
 * connect over SSH and run each automated test in order — emitting one JSON
 * object (plan §5 event shapes) per line, server → client, over a single
 * streamed HTTP response the client reads incrementally with
 * response.body.getReader().
 *
 * - Template validation failure → `{ type: "error", stage:
 *   "invalid_template" }` and the stream ends immediately (no SSH
 *   connection is ever attempted).
 * - Connection failure → `{ type: "error", stage: "connection_failed" }`
 *   and the stream ends with NO ScanHistory row written: a failed
 *   connection attempt isn't a scan result and shouldn't pollute the score
 *   history.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accepts either "192.168.1.10" or "192.168.1.10:2222" (non-standard SSH
 * port). IPv6 literals without an explicit port pass through untouched.
 * Falls back to the configured default port (scan-config) when none is given.
 */
function parseHostPort(ip: string): { host: string; port: number } {
  const m = ip.match(/^(?<host>[^:]+):(?<port>\d+)$/);
  if (m?.groups) return { host: m.groups.host, port: Number(m.groups.port) };
  return { host: ip, port: scanConfig.defaultPort };
}

export async function POST(req: NextRequest) {
  let body: { assetId?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const assetId = typeof body.assetId === "string" ? body.assetId : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!assetId) return Response.json({ error: "assetId is required." }, { status: 400 });
  if (!password) return Response.json({ error: "password is required." }, { status: 400 });

  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { cis: true },
  });
  if (!asset) return Response.json({ error: "Asset not found." }, { status: 404 });

  // The password lives only in this function's scope (and the scanner's
  // memory) for the duration of one scan — never written to disk or DB.
  const { host, port } = parseHostPort(asset.ipAddress);
  const cisContent = asset.cis.content;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: ScanEvent) => 
        {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        };

      try {
        send({ type: "status", stage: "preparing" });

        // Validate/filter the template FIRST — before touching the network
        // (build prompt 13). Invalid data never reaches SSH.
        //sleep for 2 seconds to simulate template validation time
        //await new Promise((resolve) => setTimeout(resolve, 20000));
        let tests;
        try {
          tests = parseCisContent(cisContent);
        } catch (err) {
          if (err instanceof CisContentError) {
            send({
              type: "error",
              stage: "invalid_template",
              message: err.message,
            });
            return; // ends the stream — no connection, no history
          }
          throw err;
        }

        send({ type: "status", stage: "testing_connectivity" });
        // Connect as the SSH account stored ON THIS ASSET — the Asset row is
        // the single source of truth for the username (set per asset in the
        // create/edit form). The scan-config/env value is deliberately NOT
        // consulted here: it must not override what the asset says.
        scanner.setTarget(host, asset.username, password, port);
        const connected = await scanner.connect();
        if (!connected) {
          send({
            type: "error",
            stage: "connection_failed",
            message: `Could not connect to ${asset.username}@${host}:${port}. Check the IP address, that SSH is reachable, and that the password is correct.`,
          });
          return; // ends the stream — no history written
        }

        send({ type: "status", stage: "connected" });
        if (!(await scanner.testConnectivity())) {
          send({
            type: "error",
            stage: "connection_failed",
            message: "Connected, but the host did not respond to a basic command.",
          });
          return;
        }

        send({ type: "status", stage: "verifying_privileges" });
        // Privilege preflight (plan §4): after SSH connectivity succeeds but
        // BEFORE any rule runs. root → `id -u`; non-root → `sudo -S -k -p ''
        // -- id -u` with the entered password via stdin. A failed preflight
        // stops the COMPLETE scan — no audit command is ever executed.
        const privileges = await scanner.verifyPrivileges();
        if (!privileges.ok) {
          send({
            type: "error",
            stage: "privilege_failed",
            message:
              privileges.message ??
              "SSH connected, but the account could not run commands as root.",
          });
          return; // ends the stream — no history written
        }

        send({ type: "status", stage: "scanning_started", total: tests.length });

        let passedCount = 0;
        let failedCount = 0;
        let errorCount = 0;
        for (let i = 0; i < tests.length; i++) {
          const test = tests[i];
          const { status, error } = await scanner.runTest(test);
          if (status === "passed") passedCount++;
          else if (status === "failed") failedCount++;
          else errorCount++;
          send({
            type: "test_result",
            index: i + 1,
            rule_id: test.rule_id,
            title: test.title,
            severity: test.severity,
            status,
            // Short execution diagnostic only (plan §12) — no command output:
            // stdout can contain sensitive system information (e.g. /etc/shadow).
            ...(status === "error" && error ? { error } : {}),
          });
        }

        // Errors are never counted as passed (plan §9): score is the share of
        // rules that were executed and confirmed compliant; errors are
        // reported separately so an unevaluable rule is visible, not hidden.
        const score = tests.length > 0 ? Math.round((passedCount / tests.length) * 100) : 0;
        send({
          type: "complete",
          score,
          passed: passedCount,
          failed: failedCount,
          errors: errorCount,
          total: tests.length,
        });

        // Only a completed scan (with at least one mechanical check) counts
        // as history.
        if (tests.length > 0) {
          await recordScan(asset.id, score);
        }
      } catch (err) {
        console.error("[scan] unexpected failure:", err);
        send({
          type: "error",
          stage: "scan_failed",
          message: `Scan failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        scanner.disconnect();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
