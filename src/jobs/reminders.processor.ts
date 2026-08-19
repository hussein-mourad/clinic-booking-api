import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../db/database.module';
import type { Database } from '../db/database.module';
import { appointments, notifications } from '../db';
import { logJobRun } from './job-run.helper';
import { REMINDER_JOB, REMINDERS_QUEUE, ReminderJobData } from './reminders.constants';

/**
 * Sends the T-24h appointment reminder by writing a notification row.
 *
 * Retry-idempotent two ways: re-check the appointment is STILL scheduled
 * (cancellation may have removed the job or the status changed), and skip when
 * a reminder for this appointment already exists — a retried job never writes
 * a second notification row.
 */
@Processor(REMINDERS_QUEUE)
export class RemindersProcessor extends WorkerHost {
  private readonly logger = new Logger(RemindersProcessor.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {
    super();
  }

  async process(job: Job<ReminderJobData>): Promise<void> {
    if (job.name !== REMINDER_JOB) return;
    logJobRun(this.logger, REMINDERS_QUEUE, job, 'start', { appointmentId: job.data.appointmentId });

    const [appointment] = await this.db
      .select({ id: appointments.id, patientId: appointments.patientId, status: appointments.status })
      .from(appointments)
      .where(eq(appointments.id, job.data.appointmentId))
      .limit(1);

    if (!appointment || appointment.status !== 'scheduled') {
      logJobRun(this.logger, REMINDERS_QUEUE, job, 'skipped (no active appointment)', {
        appointmentId: job.data.appointmentId,
        status: appointment?.status,
      });
      return;
    }

    const [existing] = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, 'reminder'),
          sql`${notifications.payload}->>'appointmentId' = ${String(appointment.id)}`,
        ),
      )
      .limit(1);
    if (existing) {
      logJobRun(this.logger, REMINDERS_QUEUE, job, 'skipped (reminder already sent)', {
        notificationId: existing.id,
      });
      return;
    }

    const [row] = await this.db
      .insert(notifications)
      .values({
        userId: appointment.patientId,
        type: 'reminder',
        payload: {
          appointmentId: appointment.id,
          doctorId: job.data.doctorId,
          startTime: job.data.startTime,
          sentAt: new Date().toISOString(),
        },
      })
      .returning({ id: notifications.id });

    logJobRun(this.logger, REMINDERS_QUEUE, job, 'sent', {
      notificationId: row?.id,
      appointmentId: appointment.id,
      patientId: appointment.patientId,
    });
  }
}