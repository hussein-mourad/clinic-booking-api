import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { DRIZZLE, DATABASE_POOL } from '../src/db/database.module';
import type { Database } from '../src/db/database.module';
import { appointments, users } from '../src/db';

async function registerUser(app: INestApplication, role: 'patient' | 'doctor', name: string) {
  const email = `${role}+${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'secret123', name, role })
    .expect(201);
  return { token: res.body.token as string, user: res.body.user as { id: number } };
}

/** A date N days from today whose weekday is in 0..4 (Sun-Thu). */
function nextWorkingDay(offsetDays: number): string {
  const start = new Date(Date.now() + offsetDays * 86_400_000);
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (d.getUTCDay() > 4) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('Appointments (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  const emails: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    for (const email of emails) {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (user) {
        await db.delete(appointments).where(eq(appointments.doctorId, user.id));
        await db.delete(appointments).where(eq(appointments.patientId, user.id));
        await db.delete(users).where(eq(users.id, user.id));
      }
    }
    await (app.get(DATABASE_POOL) as Pool).end();
    await app.close();
  });

  async function makeDoctorAndSlot() {
    const doctor = await registerUser(app, 'doctor', 'Dr Appt');
    const patient = await registerUser(app, 'patient', 'Appt Patient');
    const other = await registerUser(app, 'patient', 'Appt Rival');
    emails.push(
      (await db.select({ email: users.email }).from(users).where(eq(users.id, doctor.user.id)))[0]!.email,
      (await db.select({ email: users.email }).from(users).where(eq(users.id, patient.user.id)))[0]!.email,
      (await db.select({ email: users.email }).from(users).where(eq(users.id, other.user.id)))[0]!.email,
    );

    const day = nextWorkingDay(2);
    const dayOfWeek = new Date(`${day}T00:00:00Z`).getUTCDay();
    await request(app.getHttpServer())
      .patch('/doctors/me')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ slotDurationMin: 30 })
      .expect(200);
    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ entries: [{ dayOfWeek, startTime: '10:00', endTime: '13:00' }] })
      .expect(200);

    const start = `${day}T10:00:00.000Z`;
    return { doctor, patient, other, start };
  }

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .post('/appointments')
      .send({ doctorId: 1, startTime: '2026-08-23T10:00:00.000Z' })
      .expect(401);
  });

  it('books a valid slot and lists it under my appointments', async () => {
    const { doctor, patient, start } = await makeDoctorAndSlot();

    const book = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: start })
      .expect(201);
    expect(book.body).toMatchObject({
      doctorId: doctor.user.id,
      patientId: patient.user.id,
      status: 'scheduled',
    });
    expect(book.body.startTime).toBe(start);

    const mine = await request(app.getHttpServer())
      .get('/appointments/me')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    expect(mine.body.map((a: { id: number }) => a.id)).toContain(book.body.id);
  });

  it('hides completed appointments by default and includes them with includeHistory=true', async () => {
    const { doctor, patient, start } = await makeDoctorAndSlot();

    const completed = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: start })
      .expect(201);

    await db
      .update(appointments)
      .set({ status: 'completed' })
      .where(eq(appointments.id, completed.body.id));

    const defaultMine = await request(app.getHttpServer())
      .get('/appointments/me')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    expect(defaultMine.body.map((a: { id: number }) => a.id)).not.toContain(completed.body.id);

    const historyMine = await request(app.getHttpServer())
      .get('/appointments/me?includeHistory=true')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    expect(historyMine.body.map((a: { id: number }) => a.id)).toContain(completed.body.id);
  });

  it('rejects a second booking for the same slot with 409', async () => {
    const { doctor, patient, other, start } = await makeDoctorAndSlot();

    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: start })
      .expect(201);

    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${other.token}`)
      .send({ doctorId: doctor.user.id, startTime: start })
      .expect(409);
  });

  it('returns 400 for a slot that is not available', async () => {
    const { doctor, patient, start } = await makeDoctorAndSlot();
    const offGrid = new Date(new Date(start).getTime() + 7 * 60_000).toISOString();

    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: offGrid })
      .expect(400);
  });

  it('returns 400 for a non-working day and 404 for an unknown doctor', async () => {
    const { doctor, patient } = await makeDoctorAndSlot();
    const saturday = nextWorkingDay(2);
    const day = new Date(`${saturday}T00:00:00Z`).getUTCDay();
    const sat = day > 4 ? saturday : new Date(new Date(`${saturday}T00:00:00Z`).getTime() + 4 * 86_400_000).toISOString().slice(0, 10);

    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: `${sat}T10:00:00.000Z` })
      .expect(400);

    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: 999999, startTime: '2026-08-23T10:00:00.000Z' })
      .expect(404);
  });

  it('forbids doctors from booking', async () => {
    const { doctor, start } = await makeDoctorAndSlot();
    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ doctorId: doctor.user.id, startTime: start })
      .expect(403);
  });

  it('cancels an own booking and rejects double-cancel / foreign cancel', async () => {
    const { doctor, patient, other, start } = await makeDoctorAndSlot();

    const book = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: start })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/appointments/${book.body.id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(404);

    const cancelled = await request(app.getHttpServer())
      .delete(`/appointments/${book.body.id}`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.cancelledAt).toBeDefined();

    await request(app.getHttpServer())
      .delete(`/appointments/${book.body.id}`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(409);
  });

  it('rejects cancelling within the 2-hour window with 422', async () => {
    const { doctor, patient } = await makeDoctorAndSlot();
    const soon = new Date(Date.now() + 30 * 60_000);

    const [row] = await db
      .insert(appointments)
      .values({
        doctorId: doctor.user.id,
        patientId: patient.user.id,
        startTime: soon,
        endTime: new Date(soon.getTime() + 30 * 60_000),
        status: 'scheduled',
      })
      .returning({ id: appointments.id });

    await request(app.getHttpServer())
      .delete(`/appointments/${row!.id}`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(422);
  });
});