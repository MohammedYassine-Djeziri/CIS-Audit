// Cleans up the report-route validation fixtures. Run:
// npx tsx scripts/cleanup-report-fixtures.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const cis = await prisma.cisTemplate.findFirst({
    where: { name: "CIS Ubuntu 24.04 (validation)" },
  });
  if (!cis) {
    console.log("nothing to clean");
    return;
  }
  const deleted = await prisma.cisTemplate.delete({ where: { id: cis.id } });
  console.log("cleaned cisTemplate (cascade removes asset + scans):", deleted.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
