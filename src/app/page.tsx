import { getAssets } from "@/lib/actions/assets";
import { listCisTemplates } from "@/lib/actions/cis";
import { AssetList } from "./components/AssetList";

// Asset/template data is live — always render on demand, never prerender.
export const dynamic = "force-dynamic";

export default async function Home() {
  const [assets, templates] = await Promise.all([getAssets(), listCisTemplates()]);
  return <AssetList assets={assets} templates={templates} />;
}
