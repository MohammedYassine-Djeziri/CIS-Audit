/**
 * Mock SSH server for local development/testing of the scan pipeline
 * without a real target VM. Listens on 127.0.0.1:2222, accepts password
 * "testpass" for any user, and answers every exec request with canned,
 * deterministic output.
 *
 *   npx tsx scripts/mock-ssh-server.ts
 *
 * Then create an asset with IP address "127.0.0.1:2222" and scan it with
 * the password "testpass".
 */

import { generateKeyPairSync } from "node:crypto";
import { Server } from "ssh2";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const hostKey = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const PASSWORD = "testpass";

function outputFor(command: string): string {
  const cmd = command.toLowerCase();
  if (cmd.includes("is-enabled")) return "enabled\n";
  if (cmd.includes("is-active")) return "active\n";
  if (cmd.includes("dpkg -l") || cmd.includes("dpkg")) {
    return "ii mockpkg 1.0 amd64 mock package\n";
  }
  if (cmd.includes("stat")) return "/mock/path root\n";
  if (cmd.includes("echo")) return "ok\n";
  return ""; // empty output — exercises the output_empty checks too
}

new Server({ hostKeys: [hostKey] }, (client) => {
  client.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.password === PASSWORD) {
      ctx.accept();
    } else {
      ctx.reject();
    }
  });

  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (accept, _reject, info) => {
        const stream = accept();
        // Wait a tick so the client is ready to receive before writing.
        setTimeout(() => {
          stream.write(outputFor(info.command));
          stream.exit(0);
          stream.end();
        }, 20);
      });
    });
  });

  client.on("error", () => {
    // client-side disconnects are normal at the end of a scan
  });
}).listen(2222, "127.0.0.1", () => {
  console.log("Mock SSH server listening on 127.0.0.1:2222 (password: testpass)");
});
