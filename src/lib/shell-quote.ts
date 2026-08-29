/**
 * POSIX shell argument quoting (plan §6, "safe shell quoting").
 *
 * Audit commands from trusted templates are executed as
 * `sudo -S -p '' -- /bin/sh -c <command>` (or `/bin/sh -c <command>` for
 * root). The command itself must be passed to `sh -c` as ONE safely quoted
 * argument — naive interpolation like `sudo sh -c '${command}'` breaks the
 * moment a command contains a single quote (e.g.
 * `awk -F: '!$2 {print $1}' /etc/shadow`) and can change the meaning of
 * `$`, pipes, or redirects.
 *
 * POSIX sh has exactly one character that cannot appear inside a
 * single-quoted string: the single quote itself. The standard technique is
 * to close the quoted string, insert an escaped quote (`\'`), and reopen:
 *
 *   can't  →  'can'\''t'
 *
 * Everything else — `$`, backticks, double quotes, pipes, `;`, newlines,
 * globs — is literal inside single quotes. Pure function, no I/O, no
 * "server-only" import: it must stay unit-testable (shell-quote.test.ts).
 *
 * (This deliberately quotes ONE argument; when invoking `/bin/sh -c` the
 * quoted command string is the `-c` operand.)
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
