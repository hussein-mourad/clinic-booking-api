export const REMINDERS_QUEUE = 'reminders';
export const REMINDER_JOB = 'send-reminder';
export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

export interface ReminderJobData {
  appointmentId: number;
  doctorId: number;
  startTime: string;
}

/** Deterministic jobId => re-enqueue/retry can never create a duplicate reminder. */
export const reminderJobId = (appointmentId: number) =>
  `reminder-${appointmentId}`;
