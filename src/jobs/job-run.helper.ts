import { Logger } from '@nestjs/common';
import { hostname } from 'node:os';
import { Job } from 'bullmq';

/**
 * Structured, demo-friendly log line for every BullMQ job run. Emitted in
 * addition to any `notifications` row the job writes, so operators can watch
 * ([prod:logs]) exactly what each worker did and which replica (instance) ran it.
 */
export function logJobRun(
  logger: Logger,
  queue: string,
  job: Job,
  outcome: string,
  detail?: Record<string, unknown>,
): void {
  const instance = process.env.INSTANCE_ID ?? `host:${hostname()}`;
  const suffix = detail && Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : '';
  logger.log(`[job] ${queue}::${job.name} id=${job.id} instance=${instance} -> ${outcome}${suffix}`);
}