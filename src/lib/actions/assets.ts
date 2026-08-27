"use server";

import { prisma } from "@/lib/prisma";
import type { AssetSummary } from "@/lib/types";

/**
 * Asset Server Actions (plan §4). All return plain, serializable data —
 * no Prisma models cross the wire.
 */

function toSummary(asset: {
  id: string;
  title: string;
  ipAddress: string;
  cisId: string;
  cis: { name: string };
  createdAt: Date;
}): AssetSummary {
  return {
    id: asset.id,
    title: asset.title,
    ipAddress: asset.ipAddress,
    cisId: asset.cisId,
    cisName: asset.cis.name,
    createdAt: asset.createdAt.toISOString(),
  };
}

export async function getAssets(): Promise<AssetSummary[]> {
  const assets = await prisma.asset.findMany({
    include: { cis: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return assets.map(toSummary);
}

export async function getAsset(
  id: string,
): Promise<AssetSummary | null> {
  const asset = await prisma.asset.findUnique({
    where: { id },
    include: { cis: { select: { name: true } } },
  });
  return asset ? toSummary(asset) : null;
}

export interface CreateAssetData {
  title: string;
  ipAddress: string;
  cisId: string;
}

export async function createAsset(
  data: CreateAssetData,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const title = data.title?.trim();
  const ipAddress = data.ipAddress?.trim();
  if (!title || !ipAddress || !data.cisId) {
    return { ok: false, error: "Title, IP address, and CIS template are all required." };
  }

  const template = await prisma.cisTemplate.findUnique({ where: { id: data.cisId } });
  if (!template) return { ok: false, error: "Selected CIS template does not exist." };

  const asset = await prisma.asset.create({
    data: { title, ipAddress, cisId: data.cisId },
  });
  return { ok: true, id: asset.id };
}

export async function updateAsset(
  id: string,
  data: CreateAssetData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const title = data.title?.trim();
  const ipAddress = data.ipAddress?.trim();
  if (!title || !ipAddress || !data.cisId) {
    return { ok: false, error: "Title, IP address, and CIS template are all required." };
  }
  try {
    await prisma.asset.update({
      where: { id },
      data: { title, ipAddress, cisId: data.cisId },
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "Asset not found or update failed." };
  }
}

export async function deleteAsset(id: string): Promise<void> {
  await prisma.asset.delete({ where: { id } });
}
