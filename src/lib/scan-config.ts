import "server-only";

/**
 * Central, pre-defined SSH/scan configuration (plan §7b, open item
 * "SSH username").
 *
 * Every magic value that used to live inline in the scanner — the default
 * port, the SSH handshake timeout, an optional socket timeout, keepalive,
 * per-command timeout, and the SOURCE network interface to connect from —
 * lives here as a typed, environment-driven config. This is the single place
 * to tune how the process interfaces with the target host; the scanner and
 * the scan route both read from it, so defaults can be changed without
 * touching code.
 *
 * NOTE: the SSH username is intentionally NOT part of this config. It is
 * stored per-asset in the database (Asset.username) and is the single source
 * of truth for who the scanner connects as.
 *
 * The actual SSH transport is performed by `node-ssh` → `ssh2`, whose
 * `ConnectConfig` exposes:
 *   readyTimeout, timeout, keepaliveInterval, keepaliveCountMax,
 *   localAddress (source IP/interface to bind to), localPort (source port).
 * `ssh2.ExecOptions` does NOT expose a per-command timeout, so
 * `commandTimeoutMs` is implemented in the scanner with a Promise race (the
 * only reliable way to bound a hung audit command).
 *
 * Network-interface note: by default we set NO `localAddress`, so ssh2 lets
 * the OS routing table pick whichever interface/source IP can reach the
 * destination — deterministic per-target, but if the box has multiple
 * interfaces that can all route to a target, the choice is the kernel's
 * (route metrics), which can differ across reboots. To force a specific
 * source interface for every scan, set SCAN_SSH_LOCAL_ADDRESS to that
 * interface's IP address.
 *
 * Env vars (all optional, with safe defaults):
 *   SCAN_SSH_DEFAULT_PORT          default 22
 *   SCAN_SSH_READY_TIMEOUT_MS      default 10000  (ssh2 ConnectConfig.readyTimeout)
 *   SCAN_SSH_SOCKET_TIMEOUT_MS     default unset  (ssh2 ConnectConfig.timeout)
 *   SCAN_SSH_KEEPALIVE_INTERVAL_MS default unset  (ssh2 ConnectConfig.keepaliveInterval)
 *   SCAN_SSH_LOCAL_ADDRESS         default unset  (ssh2 ConnectConfig.localAddress)
 *   SCAN_SSH_LOCAL_PORT            default unset  (ssh2 ConnectConfig.localPort)
 *   SCAN_COMMAND_TIMEOUT_MS        default unset  (per audit-command guard)
 */

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Reads a raw string env var, returning `undefined` when it's unset/blank.
 * Used for optional values we genuinely want to leave OUT of the payload
 * (so e.g. an empty `localAddress` keeps control with the OS).
 */
function optStrEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() ? raw : undefined;
}

function optNumEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface ScanConfig {
  /** Port used when an asset IP has no explicit `host:port`. */
  defaultPort: number;
  /** ms to wait for the SSH handshake to complete (ssh2 `readyTimeout`). */
  readyTimeoutMs: number;
  /** Optional underlying socket timeout in ms (ssh2 `timeout`). */
  socketTimeoutMs?: number;
  /** Optional SSH keepalive interval in ms (ssh2 `keepaliveInterval`). */
  keepaliveIntervalMs?: number;
  /** Optional per audit-command timeout in ms (scanner-side guard). */
  commandTimeoutMs?: number;
  /**
   * Optional SOURCE IP of the network interface to bind/connect from
   * (ssh2 `localAddress`). Unset by default — the OS routing table picks
   * the source interface per target. Set it to force one interface.
   */
  localAddress?: string;
  /** Optional source port to connect from (ssh2 `localPort`). */
  localPort?: number;
}

export const scanConfig: ScanConfig = {
  defaultPort: numEnv("SCAN_SSH_DEFAULT_PORT", 22),
  readyTimeoutMs: numEnv("SCAN_SSH_READY_TIMEOUT_MS", 10_000),
  socketTimeoutMs: optNumEnv("SCAN_SSH_SOCKET_TIMEOUT_MS"),
  keepaliveIntervalMs: optNumEnv("SCAN_SSH_KEEPALIVE_INTERVAL_MS"),
  commandTimeoutMs: optNumEnv("SCAN_COMMAND_TIMEOUT_MS"),
  localAddress: optStrEnv("SCAN_SSH_LOCAL_ADDRESS"),
  localPort: optNumEnv("SCAN_SSH_LOCAL_PORT"),
};

/**
 * The fixed, pre-defined piece of every `ssh2` `ConnectConfig` — the
 * timeouts, keepalive, and optional source interface/port that don't change
 * per target. Spread this into the per-scan connect call alongside
 * `host`/`port`/`username`/`password`.
 */
export function baseConnectOptions(): {
  readyTimeout: number;
  timeout?: number;
  keepaliveInterval?: number;
  localAddress?: string;
  localPort?: number;
} {
  return {
    readyTimeout: scanConfig.readyTimeoutMs,
    ...(scanConfig.socketTimeoutMs !== undefined
      ? { timeout: scanConfig.socketTimeoutMs }
      : {}),
    ...(scanConfig.keepaliveIntervalMs !== undefined
      ? { keepaliveInterval: scanConfig.keepaliveIntervalMs }
      : {}),
    ...(scanConfig.localAddress ? { localAddress: scanConfig.localAddress } : {}),
    ...(scanConfig.localPort !== undefined ? { localPort: scanConfig.localPort } : {}),
  };
}
