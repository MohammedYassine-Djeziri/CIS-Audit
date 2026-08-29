// Seeds a CisTemplate + Asset + ScanHistory snapshot for live report-route
// validation. Prints the scanId. Run: npx tsx scripts/seed-report-fixtures.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const cis = await prisma.cisTemplate.create({
    data: {
      name: "CIS Ubuntu 24.04 (validation)",
      content: [],
    },
  });
  const asset = await prisma.asset.create({
    data: {
      title: "Production / Web Server #1",
      ipAddress: "192.168.1.50",
      username: "auditor",
      cisId: cis.id,
    },
  });
  const scan = await prisma.scanHistory.create({
    data: {
      assetId: asset.id,
      score: 50,
      passed: 2,
      failed: 1,
      errors: 1,
      total: 4,
      results: [
        {
          rule_id: "UBTU-24-010001",
          number: "1.1.1",
          title: "GRUB bootloader must have a password",
          severity: "CAT I",
          status: "passed",
          auditCommands: ["sudo grep password_pbkdf2 /boot/grub/grub.cfg"],
          auditProcedure: "Verify grub is protected.",
          remediation: "Set a grub password.",
          executions: [
            { command: "sudo grep password_pbkdf2 /boot/grub/grub.cfg", stdout: "password_pbkdf2 host set", stderr: "", exitCode: 0 },
          ],
          executionMode: "sudo",
        },
        {
          rule_id: "UBTU-24-010002",
          number: "1.2.2",
          title: "GPG keys must be configured",
          severity: "CAT II",
          status: "passed",
          auditCommands: ["sudo apt-key list"],
          auditProcedure: "Verify keys.",
          remediation: "Configure keys.",
          executions: [],
          executionMode: "sudo",
        },
        {
          rule_id: "UBTU-24-300027",
          number: "1.70",
          title: "The operating system must not have accounts configured with blank passwords",
          severity: "CAT I",
          status: "failed",
          auditCommands: [
            "sudo awk -F: '!$2 {print $1}' /etc/shadow",
            "sudo systemctl is-enabled ssh",
          ],
          auditProcedure: "Verify all accounts on the system have a password.",
          remediation:
            "Configure all accounts on the system to have a password or lock the account.\nRun: sudo passwd <username> for each account listed in the finding.",
          executions: [
            { command: "sudo awk -F: '!$2 {print $1}' /etc/shadow", stdout: "test-account\nlegacy-account", stderr: "", exitCode: 0 },
            { command: "sudo systemctl is-enabled ssh", stdout: "enabled\n", stderr: "", exitCode: 0 },
          ],
          executionMode: "sudo",
        },
        {
          rule_id: "UBTU-24-600150",
          number: "6.2.11",
          title: "No unowned or ungrouped files must exist",
          severity: "CAT II",
          status: "error",
          error: "Command timed out after 60 seconds.",
          errorCategory: "timeout",
          exit_code: -1,
          auditCommands: ["sudo find / -type d -perm -002 ! -perm -1000"],
          auditProcedure: "Find world-writable dirs.",
          remediation: "Review unowned files.",
          executions: [],
          executionMode: "sudo",
        },
      ],
    },
  });
  console.log("SEEDED scanId:", scan.id, "assetId:", asset.id, "cisId:", cis.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
