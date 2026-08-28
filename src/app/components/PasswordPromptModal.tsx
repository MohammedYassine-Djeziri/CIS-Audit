"use client";

import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";
import type { AssetSummary } from "@/lib/types";

/**
 * Asks for the asset's SSH account password before a scan starts. On submit the
 * password goes straight to the streamed /api/scan request — it lives only
 * in the Zustand store's memory for the duration of one scan and is cleared
 * as soon as the scan finishes (plan §6).
 */
export function PasswordPromptModal({
  show,
  asset,
  onHide,
  onSubmit,
}: {
  show: boolean;
  asset: AssetSummary;
  onHide: () => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    onSubmit(password);
    setPassword(""); // drop the value from this component's state too
  };

  return (
    <Modal show={show} onHide={onHide} backdrop="static" centered>
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton>
          <Modal.Title>Password for {asset.username}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="text-body-secondary mb-3">
            Enter the password for <strong>{asset.username}</strong> on{" "}
            <strong>{asset.title}</strong> ({asset.username}@{asset.ipAddress}) to start the scan.
            It is used for this scan only, is never stored, and is cleared when the scan completes.
          </p>
          <Form.Group controlId="scan-password">
            <Form.Label visuallyHidden>Password</Form.Label>
            <Form.Control
              type="password"
              placeholder={`${asset.username} password`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </Form.Group>
          {password && (
            <Alert variant="warning" className="mt-3 mb-0 small">
              The password travels to the server over this connection to run the scan. Only run
              scans over localhost or HTTPS.
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onHide}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Start scan
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}