import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { DRIZZLE, DATABASE_POOL } from '../src/database/database.module';
import type { Database } from '../src/database/database.module';
import { appointments, notifications, users } from '../src/database/schema';

let emailCounter = 0;

async function registerUser(app: INestApplication, role: 'patient' | 'doctor') {
  const email = `${role}+${Date.now()}-${emailCounter++}@example.com`;
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'secret123', name: email, role })
    .expect(201);
  return { token: res.body.token as string, user: res.body.user as { id: number } };
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function monthKey(d: Date) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

function weekdaysInMonth(monthStart: Date, weekday: number): number {
  let count = 0;
  const cursor = new Date(monthStart);
  while (cursor.getUTCMonth() === monthStart.getUTCMonth()) {
    if (cursor.getUTCDay() === weekday) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

describe('Doctor analytics (e2e)', () => {
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
        await db.delete(notifications).where(eq(notifications.userId, user.id));
        await db.delete(appointments).where(eq(appointments.doctorId, user.id));
        await db.delete(appointments).where(eq(appointments.patientId, user.id));
        await db.delete(users).where(eq(users.id, user.id));
      }
    }
    await (app.get(DATABASE_POOL) as Pool).end();
    await app.close();
  });

  async function track(user: { id: number }) {
    const email = (await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!
      .email;
    emails.push(email);
  }

  it('aggregates bookings, cancellations and utilization in SQL for a month', async () => {
    const doctor = await registerUser(app, 'doctor');
    const patient = await registerUser(app, 'patient');
    await track(doctor.user);
    await track(patient.user);

    // Aim at tomorrow so the 2h cancel window is always satisfied; the month
    // under test is the month "tomorrow" falls in.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const day = tomorrow.toISOString().slice(0, 10);
    const weekday = tomorrow.getUTCDay();
    const month = monthKey(tomorrow);

    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ entries: [{ dayOfWeek: weekday, startTime: '10:00', endTime: '12:00' }] })
      .expect(200);

    // Book two 15-min slots at 10:00 and 11:00.
    for (const [i, startTime] of [`${day}T10:00:00.000Z`, `${day}T11:00:00.000Z`].entries()) {
      await request(app.getHttpServer())
        .post('/appointments')
        .set('Authorization', `Bearer ${patient.token}`)
        .send({ doctorId: doctor.user.id, startTime })
        .expect(201);
      void i;
    }

    const list = await request(app.getHttpServer())
      .get('/appointments/me')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    const first = (list.body[0] as { id: number }).id;

    // Cancel one of the two.
    await request(app.getHttpServer())
      .delete(`/appointments/${first}`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/analytics?month=${month}`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(200);

    expect(res.body.total_appointments).toBe(2);
    expect(res.body.cancellation_rate).toBe(0.5);
    expect(Number.isInteger(res.body.peak_booking_hours)).toBe(true);
    expect(res.body.peak_booking_hours).toBeGreaterThanOrEqual(0);
    expect(res.body.peak_booking_hours).toBeLessThan(24);

    // 2 x 15 booked minutes over (120 scheduled minutes x occurrences of the weekday).
    const monthStart = new Date(`${month}-01T00:00:00Z`);
    const expectedUtil = 30 / (120 * weekdaysInMonth(monthStart, weekday));
    expect(Math.abs(res.body.avg_utilization - expectedUtil)).toBeLessThan(0.0001);
  }, 30_000);

  it('blocks non-doctors and unknown doctors, and validates month format', async () => {
    const doctor = await registerUser(app, 'doctor');
    const patient = await registerUser(app, 'patient');
    await track(doctor.user);
    await track(patient.user);

    await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/analytics?month=2026-08`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/doctors/999999999/analytics?month=2026-08')
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(404);

    await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/analytics?month=2026-13`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(400);

    await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/analytics`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(400);
  });
});