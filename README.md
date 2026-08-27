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

## Seeding a CIS benchmark

Seed any CIS/STIG benchmark JSON (any distro/version). The script infers a
machine-readable `check` field for each rule from its audit text and flags
rules it cannot decide on for manual review:

```bash
npm run seed:cis -- <benchmark.json> --name "CIS Ubuntu 24.04 Benchmark"
# apply hand-reviewed check overrides for flagged rules:
npm run seed:cis -- <benchmark.json> --name "..." --checks overrides.json
```

## Testing without a real target VM

A mock SSH server answers on 127.0.0.1:2222 with deterministic output:

```bash
npx tsx scripts/mock-ssh-server.ts
# then create an asset with IP address "127.0.0.1:2222"
# and scan it with the password "testpass"
```

## Notes

- Scans connect as `root` and stream progress from `POST /api/scan` to the
  browser (one JSON event per line). The root password is used for one scan
  only — never stored — and is cleared from memory when the scan finishes.
- Run only on localhost or behind HTTPS: the password crosses the network
  on every scan request.


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
