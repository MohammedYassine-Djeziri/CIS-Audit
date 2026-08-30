# Basic Scanner — CIS/STIG Compliance Auditing App

Basic Scanner is a single-user, internal compliance-auditing tool that runs
CIS/STIG benchmark checks against SSH-reachable hosts, scores them, tracks the
score over time, and exports a detailed PDF compliance report per scan.

Connect to any SSH-reachable Linux host, run an approved CIS/STIG benchmark
against it, and get a live progress stream in the browser plus a downloadable
PDF report with the score, per-rule findings, sanitized evidence, and
remediation guidance.

> For the deep dive — scan pipeline, PDF/report internals, data model, security
> model, project layout, and environment configuration — see
> [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Tech stack

- **Next.js (App Router, TypeScript)** — full-stack app (Server Components +
  Route Handlers)
- **PostgreSQL + Prisma** — persistence (assets, CIS templates, scan snapshots)
- **react-bootstrap** — UI components
- **Zustand** — client-side state
- **node-ssh** — server-side SSH transport
- **PDFKit** — PDF compliance report generation

All SSH and PDF work is server-only; `server-only` guards prevent it from
reaching the client bundle.

---

## Features

### Scan & score
- **Streamed scans** — one JSON event per line over a single HTTP response (no
  WebSockets, no polling): live status, per-rule results, and final score.
- **Structured check evaluation** — six check types (`output_empty`,
  `output_contains`, `output_equals`, `output_matches_regex`, `numeric_gte`,
  `manual`) judged mechanically; manual rules are excluded from the score.
- **Pass / fail / error** — execution problems (sudo failure, permission
  denied, command not found, timeout, channel error) are never reported as
  compliance failures; errors get their own summary section.
- **Score history** — a 0–100 compliance score per scan, tracked over time in
  a per-asset history table.

### Privilege & command safety
- Connects as the asset's SSH username; non-root commands are elevated with
  `sudo -S` (password supplied over SSH stdin, never embedded in the command
  string).
- Privilege preflight runs before any rule; a failed preflight aborts the scan
  cleanly instead of producing garbage results.
- POSIX shell quoting so audit commands with quotes, `$`, pipes, redirects,
  globs, and newlines run verbatim.

### Compliance report (PDF)
- One-click downloadable PDF per scan: header, doughnut chart with the score,
  per-finding section (audit procedure, original commands, sanitized evidence,
  remediation), a separate execution-errors section, and a paginated
  passed-rules appendix.
- Clean doughnut geometry (no triangular artifacts): one `arc()` per slice
  plus an overlaid center hole.
- Legend shows raw counts and percentages (e.g. `Passed — 54 (54%)`).

### Security
- The SSH/root password is memory-only — never stored, logged, or streamed.
- Command stdout/stderr are never streamed to the client; report evidence is
  ANSI-stripped, secret-redacted, and length-capped.
- Reports are generated only from the server-persisted scan snapshot; the
  browser cannot supply report data.
- Templates are validated before any network I/O.

### UI
- Asset list & detail views, create-asset modal, CIS template selection.
- Scan progress panel, scan summary, per-rule details modal, history table,
  and report download button.

---

## General information

### Setup

```bash
npm install
# .env -> DATABASE_URL="postgresql://postgres@127.0.0.1:5432/basic_scanner"
npx prisma migrate dev
npm run dev
```

### Getting CIS data into the database

There is no `createCisTemplate` API — templates are inserted out of band:

```bash
npm run cis:insert -- <cis-benchmark.json> --name "CIS Ubuntu 24.04 Benchmark"
```

`data/cisExample.checked.json` is a ready-to-insert, `check`-populated example.

### Running the app

```bash
npm run dev      # development server
npm run build    # production build
npm run start    # start the production build
npm run lint     # eslint
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

### Testing without a real target VM

```bash
npx tsx scripts/mock-ssh-server.ts
# create an asset with IP "127.0.0.1:2222", scan it with password "testpass"
```

### Tests

```bash
npm test
```

Covers shell quoting, sanitization/evidence prep, and PDF report generation
(including a `54/34/12` doughnut regression case). See
[ARCHITECTURE.md](./ARCHITECTURE.md) for details.

> ⚠️ Run only on localhost or behind HTTPS: the root password crosses the
> network on every scan request.
