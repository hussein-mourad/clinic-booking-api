/**
 * Concurrency proof against the LIVE API (single instance).
 *
 * Usage: bun run proof   (after `bun run dev` / `docker compose up`)
 * Env:   API_URL (default http://localhost:3000), CONCURRENCY_N (default 25)
 */

import { runConcurrencyProof } from './concurrency-core';

const API = process.env.API_URL ?? 'http://localhost:3000';
const N = Number(process.env.CONCURRENCY_N ?? 25);

async function main() {
  const stats = await runConcurrencyProof(API, N);
  console.log(
    `N=${stats.total} same-slot bookings -> ${stats.created} x201, ${stats.rejected} x409, ${stats.others} others`,
  );
  if (stats.created !== 1 || stats.rejected !== stats.total - 1) {
    console.error(`FAIL: expected exactly 1 x201 and ${stats.total - 1} x409`);
    process.exit(1);
  }
  console.log('PASS: partial unique index + ON CONFLICT DO NOTHING prevents double booking');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});