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

function nextDayOfWeek(day: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const diff = (day - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function slotHourMinutes(start: string): string {
  return new Date(start).toISOString().slice(11, 16);
}

describe('Slots (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  const emails: string[] = [];
  const createdAppointmentIds: number[] = [];

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    db = app.get(DRIZZLE);
  });

  afterAll(async () => {
    for (const id of createdAppointmentIds) {
      await db.delete(appointments).where(eq(appointments.id, id));
    }
    for (const email of emails) {
      await db.delete(users).where(eq(users.email, email));
    }
    await (app.get(DATABASE_POOL) as Pool).end();
    await app.close();
  });

  async function makeDoctor() {
    const doctor = await registerUser(app, 'doctor', 'Dr Slots');
    const patient = await registerUser(app, 'patient', 'Slot Patient');
    emails.push(
      (await db.select({ email: users.email }).from(users).where(eq(users.id, doctor.user.id)))[0]!.email,
      (await db.select({ email: users.email }).from(users).where(eq(users.id, patient.user.id)))[0]!.email,
    );
    const day = nextDayOfWeek(0);
    await request(app.getHttpServer())
      .patch('/doctors/me')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ slotDurationMin: 30 })
      .expect(200);
    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ entries: [{ dayOfWeek: 0, startTime: '10:00', endTime: '16:00' }] })
      .expect(200);
    return { doctor, patient, day };
  }

  it('lists all slots for a working day and excludes booked/blocks', async () => {
    const { doctor, patient, day } = await makeDoctor();

    const base = await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/slots?from=${day}&to=${day}`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    expect(base.body).toHaveLength(12);
    expect(slotHourMinutes(base.body[0].start)).toBe('10:00');
    expect(slotHourMinutes(base.body[base.body.length - 1].start)).toBe('15:30');

    // Full-day block => no slots
    const block = await request(app.getHttpServer())
      .post('/doctors/me/blocks')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ blockDate: day })
      .expect(201);
    const blocked = await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/slots?from=${day}&to=${day}`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    expect(blocked.body).toHaveLength(0);

    // Remove block, add a time-range block => 2 slots excluded
    await request(app.getHttpServer())
      .delete(`/doctors/me/blocks/${block.body.id}`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(200);
    const range = await request(app.getHttpServer())
      .post('/doctors/me/blocks')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ blockDate: day, startTime: '12:30', endTime: '13:30' })
      .expect(201);
    const ranged = await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/slots?from=${day}&to=${day}`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    expect(ranged.body).toHaveLength(10);
    const rangedTimes = ranged.body.map((s: { start: string }) => slotHourMinutes(s.start));
    expect(rangedTimes).not.toContain('12:30');
    expect(rangedTimes).not.toContain('13:00');

    // Booked (scheduled) appointment excludes that slot
    await request(app.getHttpServer())
      .delete(`/doctors/me/blocks/${range.body.id}`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(200);
    const [appt] = await db
      .insert(appointments)
      .values({
        doctorId: doctor.user.id,
        patientId: patient.user.id,
        startTime: new Date(`${day}T11:00:00Z`),
        endTime: new Date(`${day}T11:30:00Z`),
        status: 'scheduled',
      })
      .returning({ id: appointments.id });
    createdAppointmentIds.push(appt!.id);

    const final = await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/slots?from=${day}&to=${day}`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    const finalTimes = final.body.map((s: { start: string }) => slotHourMinutes(s.start));
    expect(finalTimes).toHaveLength(11);
    expect(finalTimes).not.toContain('11:00');
  });

  it('rejects invalid or unbounded ranges', async () => {
    const { doctor, patient } = await makeDoctor();
    await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/slots?from=2026-08-29&to=2026-08-23`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/slots?from=2026-01-01&to=2026-12-31`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/slots`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(400);
  });

  it('returns 404 for an unknown doctor', async () => {
    const patient = await registerUser(app, 'patient', 'Ghost Patient');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, patient.user.id)))[0]!.email);
    await request(app.getHttpServer())
      .get('/doctors/999999/slots?from=2026-08-23&to=2026-08-23')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(404);
  });
});