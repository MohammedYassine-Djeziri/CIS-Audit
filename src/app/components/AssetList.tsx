"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Row, Col } from "react-bootstrap";
import type { AssetSummary } from "@/lib/types";
import { AssetCard } from "./AssetCard";
import { CreateAssetButton } from "./CreateAssetButton";
import { CreateAssetModal } from "./CreateAssetModal";

/**
 * Asset list view (plan §8, `/`). Renders the create button and a grid of
 * AssetCards; empty state when no assets exist yet.
 */
export function AssetList({
  assets,
  templates,
}: {
  assets: AssetSummary[];
  templates: { id: string; name: string }[];
}) {
  const [showCreate, setShowCreate] = useState(false);
  const router = useRouter();

  return (
    <div className="container py-4">
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h1 className="h3 mb-1">Assets</h1>
          <p className="text-body-secondary mb-0">
            Hosts and the CIS benchmark each one is audited against.
          </p>
        </div>
        <CreateAssetButton onClick={() => setShowCreate(true)} disabled={templates.length === 0} />
      </div>

      {templates.length === 0 && (
        <div className="alert alert-warning">
          No CIS templates are seeded yet. Seed one before creating assets:
          <code className="ms-1">
            npx tsx prisma/insert-cis-template.ts &lt;benchmark.json&gt; --name &quot;...&quot;
          </code>
        </div>
      )}

      {assets.length === 0 ? (
        <div className="text-center text-body-secondary py-5">
          <p className="h5">No assets yet</p>
          <p>Create your first asset to start scanning.</p>
        </div>
      ) : (
        <Row xs={1} md={2} lg={3} className="g-3">
          {assets.map((asset) => (
            <Col key={asset.id}>
              <AssetCard asset={asset} />
            </Col>
          ))}
        </Row>
      )}

      <CreateAssetModal
        show={showCreate}
        onHide={() => setShowCreate(false)}
        templates={templates}
        onCreated={() => {
          setShowCreate(false);
          router.refresh();
        }}
      />
    </div>
  );
}
