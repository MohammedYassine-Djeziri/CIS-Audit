/**
 * One-off helper for getting a CisTemplate row into Postgres out of band
 * (plan § build prompt 4 — there is no createCisTemplate API in this app;
 * §4 only has list/get).
 *
 * It does NO transformation and NO validation on purpose: CIS JSON files
 * are expected to already carry their `check` fields, and all correctness
 * checking happens later, in parseCisContent (src/lib/cis-parser.ts), which
 * runs every time a scan starts. This script only exists because a raw SQL
 * insert of a large JSON array is awkward by hand.
 *
 * Usage (run by hand, as many files as you like):
 *   npx tsx prisma/insert-cis-template.ts <file.json> [--name "CIS Ubuntu 24.04 Benchmark"]
 *
 * Re-running with the same --name updates that template's content;
 * a different --name inserts an additional template row.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) {
    console.error(
      'Usage: npx tsx prisma/insert-cis-template.ts <cis-benchmark.json> [--name "CIS Ubuntu 24.04 Benchmark"]',
    );
    process.exit(1);
  }

  const nameFlagIdx = args.indexOf("--name");
  const name =
    nameFlagIdx !== -1 && args[nameFlagIdx + 1]
      ? args[nameFlagIdx + 1]
      : `CIS benchmark (${path.basename(file)})`;

  const content = JSON.parse(readFileSync(file, "utf8")) as Prisma.InputJsonValue;

  const existing = await prisma.cisTemplate.findFirst({ where: { name } });
  const template = existing
    ? await prisma.cisTemplate.update({
        where: { id: existing.id },
        data: { content },
      })
    : await prisma.cisTemplate.create({ data: { name, content } });

  console.log(`Inserted/updated CisTemplate "${template.name}" (${template.id})`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
