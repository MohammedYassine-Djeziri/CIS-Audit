import { notFound } from "next/navigation";
import { getAsset } from "@/lib/actions/assets";
import { getHistory } from "@/lib/actions/history";
import { AssetDetailView } from "@/app/components/AssetDetailView";

export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const asset = await getAsset(id);
  if (!asset) notFound();

  const history = await getHistory(id);
  return <AssetDetailView asset={asset} initialHistory={history} />;
}
