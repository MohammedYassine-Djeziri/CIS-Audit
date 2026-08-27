import "server-only";
import { NodeSSH, type SSHExecCommandResponse } from "node-ssh";
import type { CisTest, CheckType } from "./types";

export interface CommandResult {
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
 * The scan always connects as root (plan, open item "SSH username" — the
 * original spec is "root password"; most audit commands need privilege).
 */
class Scanner {
  private ssh: NodeSSH;
  private host!: string;
  private username!: string;
  private password!: string;
  private port = 22;

  constructor() {
    this.ssh = new NodeSSH();
  }

  setTarget(host: string, username: string, password: string, port = 22): void {
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
        readyTimeout: 10_000,
      });
      return true;
    } catch (err) {
      console.error(
        `[scanner] connect failed for ${this.username}@${this.host}:${this.port}:`,
        err,
      );
      return false;
    }
  }

  /** Simple liveness probe once connected. */
  async testConnectivity(): Promise<boolean> {
    try {
      const res = await this.executeCommand("echo ok");
      return res.code === 0 && res.stdout.trim() === "ok";
    } catch {
      return false;
    }
  }

  async executeCommand(cmd: string): Promise<CommandResult> {
    const res: SSHExecCommandResponse = await this.ssh.execCommand(cmd);
    // ssh2 reports code as null when the process is killed without an exit
    // status — normalize to a non-zero value so checks fail closed.
    return { stdout: res.stdout, stderr: res.stderr, code: res.code ?? 255 };
  }

  /**
   * The payoff of the structured `check` field (plan §3): one switch over
   * the six CheckType variants, the same shape for every rule from every
   * benchmark.
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
   * Runs every audit command of a rule in order, concatenates their stdout,
   * and judges the combined output against the rule's `check`.
   */
  async runTest(test: CisTest): Promise<{ passed: boolean; output: string }> {
    const chunks: string[] = [];

    for (const cmd of test.audit_command) {
      try {
        const res = await this.executeCommand(cmd);
        if (res.stdout) chunks.push(res.stdout);
        if (res.stderr) chunks.push(res.stderr);
      } catch (err) {
        // A single failing command shouldn't abort the whole scan — record
        // the error text and let `check` judge it (which will usually fail).
        console.error(`[scanner] command failed for ${test.rule_id}: ${cmd}`, err);
        chunks.push(`[command error] ${String(err)}`);
      }
    }

    const output = chunks.join("\n");
    return { passed: this.verify(test.check, output), output };
  }

  disconnect(): void {
    if (this.ssh.isConnected()) {
      this.ssh.dispose();
    }
  }
}

export const scanner = new Scanner();
