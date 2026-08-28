# Basic Scanner — CIS Auditing App

Scan SSH-reachable hosts against CIS/STIG benchmark templates and track the
compliance score over time. Built with Next.js (App Router, TypeScript),
PostgreSQL + Prisma, react-bootstrap, Zustand, and node-ssh (server-side
only).

## Setup

```bash
npm install
# .env -> DATABASE_URL="postgresql://postgres@127.0.0.1:5432/basic_scanner"
npx prisma migrate dev
npm run dev
```

## Getting CIS data into the database

There is no `createCisTemplate` API in this app (§4 only exposes `list`/`get`),
so a `CisTemplate` row gets in **out of band** — a direct SQL insert, Prisma
Studio, or this throwaway one-off script (run by hand, as many files as you
like). It does no transformation and no validation on purpose: CIS JSON
files are expected to already carry their `check` fields, and all
correctness checking happens later, in `parseCisContent`
(`src/lib/cis-parser.ts`), which runs every time a scan starts.

```bash
# file must already contain a `check` field per rule (plan §3)
npm run cis:insert -- <cis-benchmark.json> --name "CIS Ubuntu 24.04 Benchmark"
```

`data/cisExample.checked.json` is a ready-to-insert, `check`-populated copy of
the plan's example (the raw `Plan/cisExample.json` has no `check` fields and
would be rejected at scan time with `{ type: "error", stage: "invalid_template" }`).

## Scanning

Scans connect as `root` and stream progress from `POST /api/scan` to the
browser (one JSON event per line, plan §5). The route validates the asset's
template with `parseCisContent` **before** opening any SSH connection — a
malformed template yields `{ type: "error", stage: "invalid_template" }` and
no connection is ever attempted. The root password is used for one scan only
— never stored — and is cleared from memory when the scan finishes.

## Local testing without a real target VM

A mock SSH server answers on 127.0.0.1:2222 with deterministic output:

```bash
npx tsx scripts/mock-ssh-server.ts
# create an asset with IP address "127.0.0.1:2222", scan it with password "testpass"
```

Run only on localhost or behind HTTPS: the root password crosses the
network on every scan request.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
