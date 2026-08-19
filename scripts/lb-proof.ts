/**
 * Load-balancer proof against the PRODUCTION build (docker-compose.prod.yml).
 *
 * 1. Probes GET /health N times through the load balancer and asserts that at
 *    least two distinct API instances answer (round-robin actually spreads
 *    traffic across the replicas, not just one hot node).
 * 2. Re-runs the same-slot concurrency proof through the load balancer and
 *    asserts exactly ONE 201 and N-1 x 409.
 *
 * Usage: bun run prod:up && bun run proof:lb
 * Env:   API_URL (default http://localhost:8080), CONCURRENCY_N (default 25),
 *        LB_PROBES (default 40)
 */

import { runConcurrencyProof } from './concurrency-core';

const API = process.env.API_URL ?? 'http://localhost:8080';
const N = Number(process.env.CONCURRENCY_N ?? 25);
const PROBES = Number(process.env.LB_PROBES ?? 40);

async function tallyInstances(): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  for (let i = 0; i < PROBES; i++) {
    const body = (await fetch(`${API}/health`).then((r) => r.json())) as {
      instance?: string;
    };
    const id = body.instance ?? 'unknown';
    tally[id] = (tally[id] ?? 0) + 1;
  }
  return tally;
}

async function main() {
  const instances = await tallyInstances();
  const served = Object.keys(instances);
  console.log(`health x${PROBES} via LB -> ${JSON.stringify(instances)}`);

  if (served.length < 2) {
    console.error(
      `FAIL: expected at least 2 distinct instances behind the LB, got ${JSON.stringify(served)}`,
    );
    process.exit(1);
  }

  const stats = await runConcurrencyProof(API, N);
  console.log(
    `N=${stats.total} same-slot bookings -> ${stats.created} x201, ${stats.rejected} x409, ${stats.others} others`,
  );
  if (stats.created !== 1 || stats.rejected !== stats.total - 1) {
    console.error(`FAIL: expected exactly 1 x201 and ${stats.total - 1} x409`);
    process.exit(1);
  }
  console.log('PASS: load-balanced production build spreads traffic and prevents double booking');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});