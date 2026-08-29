import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { shellQuote } from "./shell-quote";

/**
 * Unit tests for the safe shell-quoting helper (plan §6).
 *
 * The critical property: for ANY input string `s`,
 *
 *   /bin/sh -c "printf '%s' " + shellQuote(s)
 *
 * must print back exactly `s` — i.e. the quoted form survives the remote
 * shell with its full meaning intact ($ expansion, pipes, quotes, …).
 *
 *   npx tsx --test src/lib/shell-quote.test.ts
 */

function shPrint(raw: string): string {
  // Run through a real POSIX shell — the same thing sshd + /bin/sh -c do.
  return execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(raw)}`], {
    encoding: "utf8",
  });
}

test("quotes a simple command unchanged", () => {
  assert.equal(shellQuote("echo ok"), `'echo ok'`);
});

test("escapes embedded single quotes (the awk /etc/shadow rule)", () => {
  const cmd = `awk -F: '!$2 {print $1}' /etc/shadow`;
  assert.equal(shellQuote(cmd), `'awk -F: '\\''!$2 {print $1}'\\'' /etc/shadow'`);
});

test("round-trips through a real /bin/sh: simple string", () => {
  assert.equal(shPrint("grep -E 'foo|bar' /etc/config"), "grep -E 'foo|bar' /etc/config");
});

test("round-trips through a real /bin/sh: single + double quotes, $, pipes", () => {
  const cmd = `awk -F: '!$2 {print $1}' /etc/shadow`;
  assert.equal(shPrint(cmd), cmd);
});

test("round-trips: dollar expansion is NOT performed", () => {
  const cmd = "echo $HOME; rm -rf /tmp/should-never-run";
  assert.equal(shPrint(cmd), cmd);
});

test("round-trips: backticks, redirects, semicolons, globs, newlines", () => {
  const cases = [
    "whoami `id -u` > /dev/null 2>&1",
    'echo "double \\" quotes" && ls *',
    "multi\nline\ncommand",
    "regex ^[a-z]+$ | grep -c '[0-9]'",
    "command with trailing spaces   ",
    "",
  ];
  for (const c of cases) {
    assert.equal(shPrint(c), c, `round-trip failed for: ${JSON.stringify(c)}`);
  }
});

test("round-trips: strings that are ONLY single quotes", () => {
  const cases = ["'", "''", `it's 'quoted' "and" $doubly`, `a'b'c'd'e'f'g`];
  for (const c of cases) {
    assert.equal(shPrint(c), c, `round-trip failed for: ${JSON.stringify(c)}`);
  }
});
