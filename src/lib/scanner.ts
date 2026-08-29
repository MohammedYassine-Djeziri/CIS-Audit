import "server-only";
import { NodeSSH } from "node-ssh";
import type { CisTest, CheckType, TestStatus, ScanErrorCategory } from "./types";
import { scanConfig, baseConnectOptions } from "./scan-config";
import { shellQuote } from "./shell-quote";
import { sanitizeDiagnostic } from "./sanitize";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * The evaluated result of one rule (plan §8/§9). stdout is what the check is
 * judged on; stderr and code exist purely for execution diagnostics. `error`
 * is a SHORT diagnostic message for status "error" — it must never contain
 * the command output, the password, or anything else sensitive.
 */
export interface RuleResult {
  status: TestStatus;
  error?: string;
  /** Broad failure class for status "error" (see ScanErrorCategory in types). */
  errorCategory?: ScanErrorCategory;
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Server-side SSH scanner (plan §7b).
 *
 * NOTE (plan, open item "Concurrent scans"): this module exports a shared
 * singleton that holds ONE target (host/username/password) at a time —
 * correct for a single-user internal tool where one scan runs at a time.
 * Two people scanning two different assets simultaneously would clobber
 * each other's target mid-scan. If this ever becomes multi-user, switch the
 * scan route to a per-request `new Scanner()` instance.
 *
 * The scan connects as the SSH username stored on each Asset row (DB column
 * `Asset.username`) with the password entered when the scan started. That
 * password is memory-only: never stored in the database, never logged, and
 * sent only over SSH (HTTPS/localhost between browser and server).
 *
 * Privilege model (plan §3–§5, §10):
 *  - If the SSH username is "root", audit commands run directly — there is
 *    no reason to invoke sudo when already connected as root.
 *  - Otherwise every complete audit command is wrapped as
 *      sudo -S -p '' -- /bin/sh -c '<complete command>'
 *    with the password supplied through SSH stdin (`-S`), never inside the
 *    command string, so pipes/redirects/chains are ALL elevated, not just
 *    the first part. Embedded `sudo` inside template commands is left
 *    unchanged (redundant but harmless under a root shell — plan §7).
 *  - A preflight (verifyPrivileges) runs `id -u` (root) or
 *    `sudo -S -k -p '' -- id -u` (non-root) after connect and before any
 *    rule; a failed preflight aborts the whole scan with stage
 *    "privilege_failed" instead of producing garbage results.
 */
class Scanner {
  private ssh: NodeSSH;
  private host!: string;
  private username!: string;
  private password!: string;
  private port = scanConfig.defaultPort;

  constructor() {
    this.ssh = new NodeSSH();
  }

  setTarget(host: string, username: string, password: string, port = scanConfig.defaultPort): void {
    this.host = host;
    this.username = username;
    this.password = password;
    this.port = port;
  }

  /** Connects to the target. Returns false (never throws) on failure. */
  async connect(): Promise<boolean> {
    try {
      await this.ssh.connect({
        host: this.host,
        port: this.port,
        username: this.username,
        password: this.password,
        // Combined into one object on purpose: baseConnectOptions() carries the
        // fixed, pre-defined config built from scan-config (readyTimeout +
        // optional timeout/keepalive) AND the optional SOURCE network interface
        // (localAddress/localPort → SCAN_SSH_LOCAL_ADDRESS / SCAN_SSH_LOCAL_PORT).
        // When localAddress is unset it's omitted, and the OS picks the source
        // interface automatically.
        ...baseConnectOptions(),
      });
      // The source address actually used is the configured one (SCAN_SSH_LOCAL_ADDRESS);
      // when unset it's "(OS default)" and the kernel routing table picks the interface.
      console.log(`>local address: ${scanConfig.localAddress ?? "(OS default)"}`);
      return true;
    } catch (err) {
      console.log(`<local address: ${scanConfig.localAddress ?? "(OS default)"}`);
      console.error(
        `[scanner] connect failed for ${this.username}@${this.host}:${this.port}:`,
        err,
      );
      return false;
    }
  }

  /**
   * Low-level exec: runs `command` EXACTLY as given over the SSH channel
   * (no wrapping, no sudo), optionally feeding `stdin` to the process, with
   * the configured bounded runtime. This is what the connectivity check and
   * the privilege preflight use; audit commands go through executeCommand()
   * which adds the sudo/root-shell wrapper.
   *
   * ssh2.ExecOptions exposes no per-command timeout, so a hung audit command
   * would block the scan indefinitely — race the exec against a timer; on
   * timeout, reject so callers record it as an execution error. The lingering
   * channel is torn down with the connection at scan end (disconnect()).
   */
  private async runRaw(command: string, Password?: string): Promise<CommandResult> {
    const exec = this.ssh.execCommand(command, Password === undefined ? {} : { stdin: Password });
    const timeoutMs = scanConfig.commandTimeoutMs;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`command timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      const res = await Promise.race([exec, timeout]);
      return { stdout: res.stdout, stderr: res.stderr, code: res.code ?? 255 };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Simple liveness probe once connected (unwrapped — no sudo involved). */
  async testConnectivity(): Promise<boolean> {
    try {
      const res = await this.runRaw("echo ok");
      return res.code === 0 && res.stdout.trim() === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Privilege preflight (plan §4) — runs after connect, BEFORE any rule.
   *
   * root account  → `id -u`, require stdout "0".
   * non-root      → `sudo -S -k -p '' -- id -u` with the password on stdin;
   *                 require exit 0 and stdout "0".
   *   -S: read the password from stdin.
   *   -k: invalidate any cached sudo timestamp so the password is genuinely
   *       tested (a stale timestamp must not fake a successful preflight).
   *   -p '': suppress the password prompt text.
   *   --: end sudo option parsing.
   *
   * Returns ok:false (never throws, never leaks the password) on any
   * failure; the scan route then stops with stage "privilege_failed".
   */
  async verifyPrivileges(): Promise<{ ok: boolean; message?: string }> {
    const isRoot = this.username === "root";
    const command = isRoot ? "id -u" : "sudo -S -k -p '' -- id -u";
    try {
      const res = await this.runRaw(command, isRoot ? undefined : `${this.password}\n`);
      if (res.code === 0 && res.stdout.trim() === "0") return { ok: true };
      if (isRoot) {
        return {
          ok: false,
          message:
            "SSH connected, but the root privilege preflight failed: `id -u` did not return 0.",
        };
      }
      // Log only the first stderr line and never the password.
      console.error(
        `[scanner] sudo preflight failed (exit ${res.code}): ${res.stderr.split("\n")[0]?.trim() ?? ""}`,
      );
      return {
        ok: false,
        message:
          "SSH connected, but sudo authentication failed or this account is not permitted to run commands as root.",
      };
    } catch (err) {
      console.error("[scanner] privilege preflight errored:", err);
      return {
        ok: false,
        message:
          "SSH connected, but the privilege preflight command could not be executed (timeout or channel error).",
      };
    }
  }

  /**
   * The root-shell execution wrapper (plan §5): every COMPLETE audit command
   * runs as one shell expression, so pipes, redirects, and command chains
   * are all elevated — `sudo cat /etc/shadow | awk ...` would only elevate
   * the first part, which is exactly the bug this avoids:
   *
   *   root       → /bin/sh -c '<complete command>'
   *   non-root   → sudo -S -p '' -- /bin/sh -c '<complete command>'
   *
   * The command is safely single-quoted (shellQuote), never interpolated
   * naively. For non-root accounts the sudo password is passed through the
   * SSH stdin channel (`-S`) — it is NEVER built into the command string
   * (no `echo 'password' | sudo ...`), never logged, and never appears in
   * results or errors.
   */
  async executeCommand(cmd: string): Promise<CommandResult> {
    const isRoot = this.username === "root";
    const wrapped = isRoot
      ? `/bin/sh -c ${shellQuote(cmd)}`
      : `sudo -S -p '' -- /bin/sh -c ${shellQuote(cmd)}`;
    return this.runRaw(wrapped, isRoot ? undefined : `${this.password}\n`);
  }

  /**
   * The payoff of the structured `check` field (plan §3): one switch over
   * the six CheckType variants, the same shape for every rule from every
   * benchmark.
   *
   * IMPORTANT: this is called with STDOUT ONLY (plan §8) — stderr and exit
   * codes are execution diagnostics and must never influence compliance:
   * combined output would make `output_empty` fail on a sudo error, make
   * `output_contains("active")` pass on "sudo: unable to resolve host",
   * and let a timeout message satisfy a numeric check.
   */
  verify(check: CheckType, output: string): boolean {
    switch (check.type) {
      case "output_empty":
        return output.trim().length === 0;

      case "output_contains":
        return output.includes(check.value);

      case "output_equals":
        return output.trim() === check.value;

      case "output_matches_regex":
        try {
          return new RegExp(check.pattern, "s").test(output);
        } catch {
          console.error(`[scanner] invalid regex pattern: ${check.pattern}`);
          return false;
        }

      case "numeric_gte": {
        const match = output.match(/-?\d+(\.\d+)?/);
        if (!match) return false; // no number in the output (missing/commented setting)
        return Number(match[0]) >= check.value;
      }

      case "manual":
        // Manual checks are filtered out before a scan ever runs; reaching
        // this branch means a template was misconfigured. Fail closed.
        return false;

      default:
        return false;
    }
  }

  /**
   * Decide whether a command genuinely failed to EXECUTE (plan §10) — as
   * opposed to a nonzero exit that is a normal condition for the tool
   * (grep/find use exit 1 for "no match", which can be a compliant result).
   * Returns a short diagnostic message, or null when the result may be
   * evaluated on its stdout.
   */
  private executionErrorMessage(res: CommandResult): string | null {
    if (res.code === 126) return "Command is not executable (exit 126).";
    if (res.code === 127) return "Command not found (exit 127).";
    if (res.code !== 0 && res.stderr) {
      const firstLine = res.stderr.split("\n")[0]?.trim() ?? "";
      // Definite execution problems: sudo failures ("sudo: ..."), permission
      // errors, authentication failures. Anything else nonzero (e.g. grep's
      // exit 1 = no match) is left to the check evaluation. Long term, a
      // per-rule "allowed_exit_codes" template field is the precise solution.
      if (/^(sudo:|\[sudo\])/i.test(firstLine) || /permission denied|operation not permitted|authentication failure/i.test(firstLine)) {
        return `Execution failed (exit ${res.code}): ${firstLine}`;
      }
    }
    return null;
  }

  /**
   * Runs every audit command of a rule in order, collects stdout and stderr
   * SEPARATELY (plan §8), and judges the combined stdout against the rule's
   * `check` — but only if every command actually executed. Any execution
   * failure (sudo, permission, command not found, timeout, channel error)
   * yields status "error" and the check is not applied (fail closed).
   *
   * The returned RuleResult carries the command executions (stdout, stderr,
   * exit code of the last command) alongside the status; the scan route
   * decides which parts are safe to stream. Every `error` diagnostic is
   * sanitized here: password-redacted and truncated (Phase 1, step 4).
   */
  async runTest(test: CisTest): Promise<RuleResult> {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let code = 0;

    for (const cmd of test.audit_command) {
      let res: CommandResult;
      try {
        res = await this.executeCommand(cmd);
      } catch (err) {
        // Timeout or SSH channel error — the audit could not be evaluated.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scanner] command errored for ${test.rule_id}: ${message}`);
        return {
          status: "error",
          error: this.sanitizeDiagnostic(message),
          errorCategory: message.includes("timed out") ? "timeout" : "channel",
          stdout: "",
          stderr: "",
          code: -1,
        };
      }

      code = res.code;
      if (res.stdout) stdoutChunks.push(res.stdout);
      if (res.stderr) stderrChunks.push(res.stderr);

      const execError = this.executionErrorMessage(res);
      if (execError) {
        console.error(`[scanner] execution error for ${test.rule_id}: ${execError}`);
        return {
          status: "error",
          error: this.sanitizeDiagnostic(execError),
          errorCategory: "execution",
          stdout: stdoutChunks.join("\n"),
          stderr: stderrChunks.join("\n"),
          code,
        };
      }
    }

    // Evaluate the check on STDOUT ONLY (never stderr — plan §8).
    const combinedStdout = stdoutChunks.join("\n");
    return {
      status: this.verify(test.check, combinedStdout) ? "passed" : "failed",
      stdout: combinedStdout,
      stderr: stderrChunks.join("\n"),
      code,
    };
  }

  /**
   * Applies the shared safeguards (password redaction + hard truncation) to
   * any diagnostic message this scanner is about to return. Defense in
   * depth: the scan route redacts again with the request's password, but the
   * scanner never lets its own copy of the secret into a result in the first
   * place.
   */
  private sanitizeDiagnostic(message: string): string {
    return sanitizeDiagnostic(message, this.password);
  }

  disconnect(): void {
    if (this.ssh.isConnected()) {
      this.ssh.dispose();
    }
  }
}

export const scanner = new Scanner();
