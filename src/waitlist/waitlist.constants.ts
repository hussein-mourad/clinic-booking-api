export const WAITLIST_QUEUE = 'waitlist';
export const WAITLIST_PROCESS_JOB = 'process-waitlist';
export const WAITLIST_SWEEP_JOB = 'sweep-waitlist';
export const WAITLIST_SWEEP_SCHEDULER = 'waitlist-sweep-scheduler';

export const OFFER_VALID_MS = 15 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Deterministic jobId => re-triggering a cancellation can never double-offer. */
export const waitlistProcessJobId = (appointmentId: number) =>
  `waitlist-${appointmentId}`;

export interface WaitlistProcessData {
  doctorId: number;
  slotStart: string;
}
