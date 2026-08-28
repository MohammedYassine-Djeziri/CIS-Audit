"use client";

import Link from "next/link";
import { Card, Badge } from "react-bootstrap";
import type { AssetSummary } from "@/lib/types";

/** One asset tile: title, IP address, CIS template name, link to detail. */
export function AssetCard({ asset }: { asset: AssetSummary }) {
  return (
    <Card as={Link} href={`/assets/${asset.id}`} className="text-decoration-none h-100">
      <Card.Body>
        <Card.Title className="text-body">{asset.title}</Card.Title>
        <Card.Subtitle className="text-body-secondary font-monospace mb-2">
          {asset.username}@{asset.ipAddress}
        </Card.Subtitle>
        <Badge bg="secondary">{asset.cisName}</Badge>
      </Card.Body>
    </Card>
  );
}
