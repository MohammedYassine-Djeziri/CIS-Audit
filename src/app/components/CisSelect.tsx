"use client";

import Form from "react-bootstrap/Form";

/**
 * CIS template dropdown (plan §8). Receives only {id, name} rows from
 * listCisTemplates() — the name index exists exactly to keep this listing
 * cheap; template `content` JSON is never loaded for this screen.
 */
export function CisSelect({
  templates,
  value,
  onChange,
}: {
  templates: { id: string; name: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Form.Group controlId="asset-cis">
      <Form.Label>CIS template</Form.Label>
      <Form.Select value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="" disabled>
          Select a benchmark…
        </option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Form.Select>
    </Form.Group>
  );
}
