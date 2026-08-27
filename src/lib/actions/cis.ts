"use server";

import { prisma } from "@/lib/prisma";

/**
 * CIS template Server Actions (plan §4).
 *
 * `listCisTemplates()` only ever selects id + name — that's exactly what the
 * asset-creation dropdown needs, and the `name` index (plan §2) keeps that
 * listing query cheap regardless of how large the `content` JSON gets.
 */

export async function listCisTemplates(): Promise<{ id: string; name: string }[]> {
  return prisma.cisTemplate.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** Full template row including the `content` JSON (used by the scan route). */
export async function getCisTemplate(id: string) {
  return prisma.cisTemplate.findUnique({ where: { id } });
}
