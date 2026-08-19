import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { Queue } from 'bullmq';
import { createApp } from '../src/app.factory';
import { DRIZZLE, DATABASE_POOL } from '../src/db/database.module';
import type { Database } from '../src/db/database.module';
import { appointments, notifications, users, waitingList } from '../src/db';
import {
  WAITLIST_QUEUE,
  WAITLIST_SWEEP_JOB,
} from '../src/waitlist/waitlist.constants';

let emailCounter = 0;

async function registerUser(app: INestApplication, role: 'patient' | 'doctor') {
  const email = `${role}+${Date.now()}-${emailCounter++}@example.com`;
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'secret123', name: email, role })
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

async function waitFor<T>(
  poll: () => Promise<T | undefined>,
  pred: (v: T) => boolean,
  what: string,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await poll();
    if (value !== undefined && pred(value)) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('Waiting list (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  let queue: Queue;
  const emails: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    db = app.get(DRIZZLE);
    queue = app.get(getQueueToken(WAITLIST_QUEUE));
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
        await db.delete(waitingList).where(eq(waitingList.patientId, user.id));
        await db.delete(waitingList).where(eq(waitingList.doctorId, user.id));
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

  async function track(user: { id: number }) {
    const email = (
      await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, user.id))
    )[0]!.email;
    emails.push(email);
  }

  async function setupDoctorSchedule(token: string) {
    const day = nextWorkingDay(1);
    const dayOfWeek = new Date(`${day}T00:00:00Z`).getUTCDay();
    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${token}`)
      .send({ entries: [{ dayOfWeek, startTime: '10:00', endTime: '14:00' }] })
      .expect(200);
    return { day, slot: `${day}T10:00:00.000Z` };
  }

  async function entry(id: number) {
    const [row] = await db
      .select()
      .from(waitingList)
      .where(eq(waitingList.id, id))
      .limit(1);
    return row;
  }

  it('joins, is offered on cancellation (FIFO), and accept books the slot', async () => {
    const doctor = await registerUser(app, 'doctor');
    const patientA = await registerUser(app, 'patient');
    const patientB = await registerUser(app, 'patient');
    const patientC = await registerUser(app, 'patient');
    await track(doctor.user);
    await track(patientA.user);
    await track(patientB.user);
    await track(patientC.user);

    const { slot } = await setupDoctorSchedule(doctor.token);

    const booked = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patientA.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(201);
    const appointmentId = booked.body.id as number;

    const joinB = await request(app.getHttpServer())
      .post('/waitlist')
      .set('Authorization', `Bearer ${patientB.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(201);
    const entryBId = joinB.body.id as number;
    const joinC = await request(app.getHttpServer())
      .post('/waitlist')
      .set('Authorization', `Bearer ${patientC.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(201);
    const entryCId = joinC.body.id as number;
    expect(joinB.body.position).toBe(1);
    expect(joinC.body.position).toBe(2);

    // Cannot accept before being offered; cannot join the same slot twice.
    await request(app.getHttpServer())
      .post(`/waitlist/${entryBId}/accept`)
      .set('Authorization', `Bearer ${patientB.token}`)
      .expect(409);
    await request(app.getHttpServer())
      .post('/waitlist')
      .set('Authorization', `Bearer ${patientB.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(409);

    // Cancellation triggers the process job: slot is offered to B (FIFO).
    await request(app.getHttpServer())
      .delete(`/appointments/${appointmentId}`)
      .set('Authorization', `Bearer ${patientA.token}`)
      .expect(200);

    await waitFor(
      () => entry(entryBId),
      (r) => r !== undefined && r.status === 'offered',
      'B to be offered',
    );
    // C stays waiting while B's offer is live.
    expect((await entry(entryCId))!.status).toBe('waiting');

    const bOffered = await waitFor(
      async () => {
        const rows = await db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, patientB.user.id),
              eq(notifications.type, 'waitlist_offer'),
            ),
          );
        return rows.length > 0;
      },
      (found) => found === true,
      'B offer notification to be written',
    );
    expect(bOffered).toBe(true);

    // B accepts: the guarded INSERT creates a real appointment for B.
    const accept = await request(app.getHttpServer())
      .post(`/waitlist/${entryBId}/accept`)
      .set('Authorization', `Bearer ${patientB.token}`)
      .expect(201);
    expect(accept.body.patientId).toBe(patientB.user.id);
    expect(accept.body.doctorId).toBe(doctor.user.id);
    expect((await entry(entryBId))!.status).toBe('accepted');

    const confirmation = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, patientB.user.id));
    expect(confirmation.some((n) => n.type === 'waitlist_confirmation')).toBe(
      true,
    );

    // The slot is taken again: direct booking by A now conflicts.
    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patientA.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(409);
  }, 30_000);

  it('expires stale offers via the sweep and offers the next in line', async () => {
    const doctor = await registerUser(app, 'doctor');
    const patientA = await registerUser(app, 'patient');
    const patientB = await registerUser(app, 'patient');
    const patientC = await registerUser(app, 'patient');
    await track(doctor.user);
    await track(patientA.user);
    await track(patientB.user);
    await track(patientC.user);

    const { slot } = await setupDoctorSchedule(doctor.token);

    const booked = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patientA.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(201);
    const appointmentId = booked.body.id as number;

    const joinB = await request(app.getHttpServer())
      .post('/waitlist')
      .set('Authorization', `Bearer ${patientB.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(201);
    const entryBId = joinB.body.id as number;
    const joinC = await request(app.getHttpServer())
      .post('/waitlist')
      .set('Authorization', `Bearer ${patientC.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(201);
    const entryCId = joinC.body.id as number;

    await request(app.getHttpServer())
      .delete(`/appointments/${appointmentId}`)
      .set('Authorization', `Bearer ${patientA.token}`)
      .expect(200);

    await waitFor(
      () => entry(entryBId),
      (r) => r !== undefined && r.status === 'offered',
      'B to be offered',
    );

    // Bake the offer, force it stale, then run the sweep.
    await db
      .update(waitingList)
      .set({
        offeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        offerExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .where(eq(waitingList.id, entryBId));
    await queue.add(
      WAITLIST_SWEEP_JOB,
      {},
      { jobId: `sweep-e2e-${Date.now()}-${emailCounter++}` },
    );

    await waitFor(
      () => entry(entryBId),
      (r) => r !== undefined && r.status === 'expired',
      'B offer to expire',
    );
    await waitFor(
      () => entry(entryCId),
      (r) => r !== undefined && r.status === 'offered',
      'C to be offered next',
    );

    const accept = await request(app.getHttpServer())
      .post(`/waitlist/${entryCId}/accept`)
      .set('Authorization', `Bearer ${patientC.token}`)
      .expect(201);
    expect(accept.body.patientId).toBe(patientC.user.id);
    expect((await entry(entryCId))!.status).toBe('accepted');
  }, 30_000);

  it('rejects invalid inputs and foreign entries', async () => {
    const doctor = await registerUser(app, 'doctor');
    const patient = await registerUser(app, 'patient');
    const other = await registerUser(app, 'patient');
    await track(doctor.user);
    await track(patient.user);
    await track(other.user);

    const { day, slot } = await setupDoctorSchedule(doctor.token);

    // Not on the schedule grid.
    await request(app.getHttpServer())
      .post('/waitlist')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: `${day}T15:00:00.000Z` })
      .expect(400);

    // Unknown doctor.
    await request(app.getHttpServer())
      .post('/waitlist')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: 9_999_999, startTime: slot })
      .expect(404);

    // Another patient cannot delete this entry.
    const join = await request(app.getHttpServer())
      .post('/waitlist')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(201);
    await request(app.getHttpServer())
      .delete(`/waitlist/${join.body.id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(404);
  }, 30_000);

  it("lists the patient's own waiting-list entries with status and doctor name", async () => {
    const doctor = await registerUser(app, 'doctor');
    const patient = await registerUser(app, 'patient');
    const other = await registerUser(app, 'patient');
    await track(doctor.user);
    await track(patient.user);
    await track(other.user);

    const { slot } = await setupDoctorSchedule(doctor.token);

    // Take the slot so both patients can join the waiting list.
    const booked = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${other.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(201);
    const appointmentId = booked.body.id as number;

    const join = await request(app.getHttpServer())
      .post('/waitlist')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: slot })
      .expect(201);

    const [doctorRow] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, doctor.user.id));

    const res = await request(app.getHttpServer())
      .get('/waitlist/me')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: join.body.id,
      doctorId: doctor.user.id,
      doctorName: doctorRow!.name,
      slotStart: slot,
      position: 1,
      status: 'waiting',
    });
    expect(res.body[0].offerExpiresAt).toBeNull();

    // Another patient's entries are not visible.
    const otherRes = await request(app.getHttpServer())
      .get('/waitlist/me')
      .set('Authorization', `Bearer ${other.token}`)
      .expect(200);
    expect(otherRes.body).toHaveLength(0);

    // Cleanup reflects acceptance: after cancelling, the offer appears.
    await request(app.getHttpServer())
      .delete(`/appointments/${appointmentId}`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(200);
    await waitFor(
      () => entry(join.body.id),
      (r) => r !== undefined && r.status === 'offered',
      'entry to become offered',
    );
    const after = await request(app.getHttpServer())
      .get('/waitlist/me')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    expect(after.body[0].status).toBe('offered');
    expect(after.body[0].offerExpiresAt).not.toBeNull();
  }, 30_000);
});
