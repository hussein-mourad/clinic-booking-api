import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { Queue } from 'bullmq';
import { createApp } from '../src/app.factory';
import { DRIZZLE, DATABASE_POOL } from '../src/db/database.module';
import type { Database } from '../src/db/database.module';
import { appointments, notifications, users } from '../src/db';
import {
  REMINDER_JOB,
  REMINDERS_QUEUE,
  reminderJobId,
} from '../src/jobs/reminders.constants';

async function registerUser(
  app: INestApplication,
  role: 'patient' | 'doctor',
  name: string,
) {
  const email = `${role}+${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'secret123', name, role })
    .expect(201);
  return {
    token: res.body.token as string,
    user: res.body.user as { id: number },
  };
}

function nextWorkingDay(offsetDays: number): string {
  const d = new Date(Date.UTC(1970, 0, 1));
  const start = new Date(Date.now() + offsetDays * 86_400_000);
  d.setUTCFullYear(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  while (d.getUTCDay() > 4) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Reminder job (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  let queue: Queue;
  const emails: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    db = app.get(DRIZZLE);
    queue = app.get(getQueueToken(REMINDERS_QUEUE));
  });

  afterAll(async () => {
    for (const email of emails) {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (user) {
        await db.delete(notifications).where(eq(notifications.userId, user.id));
        await db.delete(appointments).where(eq(appointments.doctorId, user.id));
        await db
          .delete(appointments)
          .where(eq(appointments.patientId, user.id));
        await db.delete(users).where(eq(users.id, user.id));
      }
    }
    await (app.get(DATABASE_POOL) as Pool).end();
    await app.close();
  });

  async function makeAppointment() {
    const doctor = await registerUser(app, 'doctor', 'Dr Reminder');
    const patient = await registerUser(app, 'patient', 'Reminder Patient');
    emails.push(
      (
        await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, doctor.user.id))
      )[0]!.email,
      (
        await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, patient.user.id))
      )[0]!.email,
    );

    const day = nextWorkingDay(3);
    const dayOfWeek = new Date(`${day}T00:00:00Z`).getUTCDay();
    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ entries: [{ dayOfWeek, startTime: '10:00', endTime: '13:00' }] })
      .expect(200);

    const book = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: `${day}T10:00:00.000Z` })
      .expect(201);
    return { doctor, patient, appointmentId: book.body.id as number };
  }

  it('enqueues a delayed reminder on booking and removes it on cancel', async () => {
    const { patient, appointmentId } = await makeAppointment();
    const jobId = reminderJobId(appointmentId);

    const job = await queue.getJob(jobId);
    expect(job).not.toBeNull();
    expect(job!.name).toBe(REMINDER_JOB);
    expect(job!.opts.delay).toBeGreaterThan(0);
    expect(job!.data.appointmentId).toBe(appointmentId);

    await request(app.getHttpServer())
      .delete(`/appointments/${appointmentId}`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);

    expect(await queue.getJob(jobId)).toBeUndefined();
  }, 20_000);

  it('writes exactly one notification and dedupes a retried job', async () => {
    const { doctor, patient, appointmentId } = await makeAppointment();

    // Remove the real (delayed) reminder so we control execution here.
    await queue.remove(reminderJobId(appointmentId));

    const stamp = Date.now();
    await queue.add(
      REMINDER_JOB,
      {
        appointmentId,
        doctorId: doctor.user.id,
        startTime: '2026-08-01T10:00:00.000Z',
      },
      { jobId: `reminder-e2e-${stamp}-first`, attempts: 1 },
    );

    const deadline = Date.now() + 10_000;
    let notification = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, patient.user.id))
      .limit(1);
    while (notification.length === 0 && Date.now() < deadline) {
      await sleep(100);
      notification = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, patient.user.id))
        .limit(1);
    }
    expect(notification).toHaveLength(1);
    expect(notification[0]!.type).toBe('reminder');
    expect(
      (notification[0]!.payload as { appointmentId: number }).appointmentId,
    ).toBe(appointmentId);

    // Simulate a retry: same appointment, different jobId. Must be a no-op.
    await queue.add(
      REMINDER_JOB,
      {
        appointmentId,
        doctorId: doctor.user.id,
        startTime: '2026-08-01T10:00:00.000Z',
      },
      { jobId: `reminder-e2e-${stamp}-retry`, attempts: 1 },
    );
    await sleep(500);

    const count = await db
      .select({ n: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, patient.user.id));
    expect(count).toHaveLength(1);
  }, 30_000);
});
