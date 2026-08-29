import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CisContentError, parseCisContent } from "@/lib/cis-parser";
import { scanner } from "@/lib/scanner";
import { scanConfig } from "@/lib/scan-config";
import { recordScan } from "@/lib/scan-history";
import { redactSecret } from "@/lib/sanitize";
import type { ScanEvent, StoredRuleResult } from "@/lib/types";

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
        // How audit commands run on this target (shown in the rule-details
        // modal as "Execution mode"): directly as root, or elevated through
        // sudo — matching the scanner's privilege model exactly.
        const executionMode = asset.username === "root" ? ("root" as const) : ("sudo" as const);
        // The server-side snapshot (report plan §9/§10): built from TRUSTED
        // data the scan itself produced — parsed rules + scanner results —
        // never from anything the client sent. Persisted below and used as
        // the sole source for report generation.
        const snapshotResults: StoredRuleResult[] = [];
        for (let i = 0; i < tests.length; i++) {
          const test = tests[i];
          const { status, error, errorCategory, code, executions } = await scanner.runTest(test);
          if (status === "passed") passedCount++;
          else if (status === "failed") failedCount++;
          else errorCount++;

          // Error results carry a SHORT sanitized diagnostic (plan §12) — no
          // command output: stdout can contain sensitive system information
          // (e.g. /etc/shadow). Redacted with the request password once more
          // (defense in depth beyond the scanner's own sanitization) and
          // hard-truncated. Command evidence (executions) is already
          // sanitized/truncated inside the scanner and is stored in the
          // snapshot only — it is never streamed to the client.
          const sanitizedError =
            status === "error" && error ? redactSecret(error, password) : undefined;
          if (sanitizedError) {
            send({
              type: "test_result",
              index: i + 1,
              rule_id: test.rule_id,
              number: test.number,
              title: test.title,
              severity: test.severity,
              status,
              // Details-modal fields, ALWAYS included (same shape for every
              // result — simplifies client state handling). auditCommands are
              // the original benchmark commands, never the internal sudo
              // wrapper, and never any stdin/stdout content.
              auditCommands: test.audit_command,
              auditProcedure: test.audit_procedure,
              remediation: test.remediation,
              executionMode,
              error: sanitizedError,
              errorCategory,
              exit_code: code,
            });
          } else {
            send({
              type: "test_result",
              index: i + 1,
              rule_id: test.rule_id,
              number: test.number,
              title: test.title,
              severity: test.severity,
              status,
              auditCommands: test.audit_command,
              auditProcedure: test.audit_procedure,
              remediation: test.remediation,
              executionMode,
            });
          }

          snapshotResults.push({
            rule_id: test.rule_id,
            number: test.number,
            title: test.title,
            severity: test.severity,
            status,
            auditCommands: test.audit_command,
            auditProcedure: test.audit_procedure,
            // Snapshot of the remediation text AS IT EXISTS NOW (report §14):
            // later CIS template edits cannot rewrite a historical report.
            remediation: test.remediation,
            executions,
            ...(sanitizedError ? { error: sanitizedError, errorCategory, exit_code: code } : {}),
            executionMode,
          });
        }

        // Errors are never counted as passed (plan §9): score is the share of
        // rules that were executed and confirmed compliant; errors are
        // reported separately so an unevaluable rule is visible, not hidden.
        const score = tests.length > 0 ? Math.round((passedCount / tests.length) * 100) : 0;

        // Only a completed scan (with at least one mechanical check) counts
        // as history. The snapshot is saved BEFORE the complete event so the
        // event can carry the trusted scan id (report plan §6/§10) — the id
        // the client uses to request the report; the report data itself is
        // loaded server-side from this row, never from browser state.
        let savedScanId: string | undefined;
        if (tests.length > 0) {
          try {
            const saved = await recordScan({
              assetId: asset.id,
              score,
              passed: passedCount,
              failed: failedCount,
              errors: errorCount,
              total: tests.length,
              results: snapshotResults,
            });
            savedScanId = saved.id;
          } catch (err) {
            // A snapshot write failure must not lose the scan the user just
            // watched complete — finish the stream without a scan id (no
            // report button), and leave a loud trace in the server log.
            console.error("[scan] failed to persist scan snapshot:", err);
          }
        }

        send({
          type: "complete",
          ...(savedScanId ? { scanId: savedScanId } : {}),
          score,
          passed: passedCount,
          failed: failedCount,
          errors: errorCount,
          total: tests.length,
        });
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
