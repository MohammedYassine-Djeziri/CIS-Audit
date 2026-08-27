"use client";

import Button from "react-bootstrap/Button";

export function CreateAssetButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="primary" onClick={onClick} disabled={disabled}>
      + Create Asset
    </Button>
  );
}
