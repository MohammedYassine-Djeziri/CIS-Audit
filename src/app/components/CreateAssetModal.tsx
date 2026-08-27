"use client";

import { useState } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";
import { createAsset } from "@/lib/actions/assets";
import { CisSelect } from "./CisSelect";

/**
 * Create-asset modal (plan §8). Collects title + IP address + CIS template,
 * calls the createAsset Server Action, and reports success back via
 * onCreated so the list can refresh.
 */
export function CreateAssetModal({
  show,
  onHide,
  templates,
  onCreated,
}: {
  show: boolean;
  onHide: () => void;
  templates: { id: string; name: string }[];
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [ipAddress, setIpAddress] = useState("");
  const [cisId, setCisId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setTitle("");
    setIpAddress("");
    setCisId("");
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const result = await createAsset({ title, ipAddress, cisId });
    setSaving(false);
    if (result.ok) {
      reset();
      onCreated();
    } else {
      setError(result.error);
    }
  };

  return (
    <Modal show={show} onHide={onHide} backdrop="static">
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton>
          <Modal.Title>Create Asset</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && (
            <Alert variant="danger" dismissible onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          <Form.Group className="mb-3" controlId="asset-title">
            <Form.Label>Title</Form.Label>
            <Form.Control
              type="text"
              placeholder="e.g. Web server (prod)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </Form.Group>
          <Form.Group className="mb-3" controlId="asset-ip">
            <Form.Label>IP address</Form.Label>
            <Form.Control
              type="text"
              placeholder="e.g. 192.168.1.10"
              value={ipAddress}
              onChange={(e) => setIpAddress(e.target.value)}
              required
            />
          </Form.Group>
          <CisSelect templates={templates} value={cisId} onChange={setCisId} />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? "Creating…" : "Create"}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
