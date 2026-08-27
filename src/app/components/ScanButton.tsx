"use client";

import Button from "react-bootstrap/Button";

/**
 * Starts the scan flow: opens the password prompt (scanning requires
 * privileged commands, so the password is collected at scan time rather
 * than stored anywhere persistent — plan §8).
 */
export function ScanButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="success" onClick={onClick} disabled={disabled}>
      {disabled ? "Scanning…" : "Run Scan"}
    </Button>
  );
}