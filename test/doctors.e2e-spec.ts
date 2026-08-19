import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { DRIZZLE, DATABASE_POOL } from '../src/db/database.module';
import type { Database } from '../src/db/database.module';
import { users, appointments, notifications } from '../src/db';

async function registerUser(app: INestApplication, role: 'patient' | 'doctor', name: string) {
  const email = `${role}+${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'secret123', name, role })
    .expect(201);
  return { token: res.body.token as string, user: res.body.user as { id: number } };
}

describe('Doctors (e2e)', () => {
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

  it('rejects unauthenticated access with 401', async () => {
    await request(app.getHttpServer()).get('/doctors/me/schedule').expect(401);
  });

  it('lists doctors for any authenticated user', async () => {
    const patient = await registerUser(app, 'patient', 'Patient Lister');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, patient.user.id)))[0]!.email);
    const doctor = await registerUser(app, 'doctor', 'Dr Listed');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, doctor.user.id)))[0]!.email);

    const res = await request(app.getHttpServer())
      .get('/doctors')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((d: { id: number }) => d.id)).toContain(doctor.user.id);
    expect(res.body.find((d: { id: number }) => d.id === doctor.user.id)).toMatchObject({
      name: 'Dr Listed',
      slotDurationMin: 15,
    });

    await request(app.getHttpServer()).get('/doctors').expect(401);
  });

  it('doctor sets and reads a weekly schedule', async () => {
    const { token, user } = await registerUser(app, 'doctor', 'Dr Schedule');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!.email);

    const put = await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entries: [
          { dayOfWeek: 0, startTime: '10:00', endTime: '16:00' },
          { dayOfWeek: 3, startTime: '09:00', endTime: '12:00' },
        ],
      })
      .expect(200);

    expect(put.body).toHaveLength(2);
    expect(put.body[0]).toMatchObject({ doctorId: user.id, dayOfWeek: 0, startTime: '10:00', endTime: '16:00' });

    const get = await request(app.getHttpServer())
      .get('/doctors/me/schedule')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(get.body).toHaveLength(2);
  });

  it('rejects duplicate days and inverted times', async () => {
    const { token, user } = await registerUser(app, 'doctor', 'Dr Bad Schedule');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!.email);

    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entries: [
          { dayOfWeek: 1, startTime: '10:00', endTime: '16:00' },
          { dayOfWeek: 1, startTime: '08:00', endTime: '09:00' },
        ],
      })
      .expect(400);

    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${token}`)
      .send({ entries: [{ dayOfWeek: 2, startTime: '16:00', endTime: '10:00' }] })
      .expect(400);
  });

  it('sets slot duration and rejects invalid values', async () => {
    const { token, user } = await registerUser(app, 'doctor', 'Dr Duration');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!.email);

    await request(app.getHttpServer())
      .patch('/doctors/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ slotDurationMin: 30 })
      .expect(200);

    await request(app.getHttpServer())
      .patch('/doctors/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ slotDurationMin: 45 })
      .expect(400);
  });

  it('adds and removes blocked slots', async () => {
    const { token, user } = await registerUser(app, 'doctor', 'Dr Blocks');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!.email);

    const fullDay = await request(app.getHttpServer())
      .post('/doctors/me/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ blockDate: '2026-08-25' })
      .expect(201);
    expect(fullDay.body).toMatchObject({ doctorId: user.id, blockDate: '2026-08-25', startTime: null, endTime: null });

    const range = await request(app.getHttpServer())
      .post('/doctors/me/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ blockDate: '2026-08-26', startTime: '12:00', endTime: '14:00' })
      .expect(201);
    expect(range.body.startTime).toBe('12:00');

    await request(app.getHttpServer())
      .post('/doctors/me/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ blockDate: '2026-08-27', startTime: '12:00' })
      .expect(400);

    await request(app.getHttpServer())
      .delete(`/doctors/me/blocks/${range.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/doctors/me/blocks/${range.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('manages only its own schedule and keeps doctors isolated', async () => {    const patient = await registerUser(app, 'patient', 'Patient');
    const doctorA = await registerUser(app, 'doctor', 'Dr A');
    const doctorB = await registerUser(app, 'doctor', 'Dr B');
    emails.push(
      (await db.select({ email: users.email }).from(users).where(eq(users.id, patient.user.id)))[0]!.email,
      (await db.select({ email: users.email }).from(users).where(eq(users.id, doctorA.user.id)))[0]!.email,
      (await db.select({ email: users.email }).from(users).where(eq(users.id, doctorB.user.id)))[0]!.email,
    );

    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ entries: [{ dayOfWeek: 0, startTime: '10:00', endTime: '16:00' }] })
      .expect(403);

    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${doctorB.token}`)
      .send({ entries: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] })
      .expect(200);

    const a = await request(app.getHttpServer())
      .get('/doctors/me/schedule')
      .set('Authorization', `Bearer ${doctorA.token}`)
      .expect(200);
    expect(a.body).toHaveLength(0);

    const b = await request(app.getHttpServer())
      .get('/doctors/me/schedule')
      .set('Authorization', `Bearer ${doctorB.token}`)
      .expect(200);
    expect(b.body).toHaveLength(1);
    expect(b.body[0]).toMatchObject({ dayOfWeek: 1 });
  });

  it('returns own profile with slot duration', async () => {
    const { token, user } = await registerUser(app, 'doctor', 'Dr Profile');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!.email);

    const res = await request(app.getHttpServer())
      .get('/doctors/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toMatchObject({ id: user.id, slotDurationMin: 15 });
    expect(res.body.email).toBeTruthy();
  });

  it('lists, reads and updates blocked slots', async () => {
    const { token, user } = await registerUser(app, 'doctor', 'Dr Blocks CRUD');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!.email);

    const created = await request(app.getHttpServer())
      .post('/doctors/me/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ blockDate: '2026-08-25', startTime: '12:00', endTime: '14:00' })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/doctors/me/blocks')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.map((b: { id: number }) => b.id)).toContain(created.body.id);

    const single = await request(app.getHttpServer())
      .get(`/doctors/me/blocks/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(single.body).toMatchObject({ blockDate: '2026-08-25', startTime: '12:00', endTime: '14:00' });

    const updated = await request(app.getHttpServer())
      .patch(`/doctors/me/blocks/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ blockDate: '2026-08-26', startTime: '09:00', endTime: '10:00' })
      .expect(200);
    expect(updated.body).toMatchObject({ blockDate: '2026-08-26', startTime: '09:00', endTime: '10:00' });

    await request(app.getHttpServer())
      .patch(`/doctors/me/blocks/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ startTime: '10:00' })
      .expect(400);

    await request(app.getHttpServer())
      .get(`/doctors/me/blocks/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('does not leak another doctor blocks and returns 404 on foreign or unknown blocks', async () => {
    const doctorA = await registerUser(app, 'doctor', 'Dr Blocks A');
    const doctorB = await registerUser(app, 'doctor', 'Dr Blocks B');
    emails.push(
      (await db.select({ email: users.email }).from(users).where(eq(users.id, doctorA.user.id)))[0]!.email,
      (await db.select({ email: users.email }).from(users).where(eq(users.id, doctorB.user.id)))[0]!.email,
    );

    const aBlock = await request(app.getHttpServer())
      .post('/doctors/me/blocks')
      .set('Authorization', `Bearer ${doctorA.token}`)
      .send({ blockDate: '2026-08-25' })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/doctors/me/blocks/${aBlock.body.id}`)
      .set('Authorization', `Bearer ${doctorB.token}`)
      .expect(404);

    await request(app.getHttpServer())
      .patch(`/doctors/me/blocks/${aBlock.body.id}`)
      .set('Authorization', `Bearer ${doctorB.token}`)
      .send({ blockDate: '2026-08-27' })
      .expect(404);

    const listB = await request(app.getHttpServer())
      .get('/doctors/me/blocks')
      .set('Authorization', `Bearer ${doctorB.token}`)
      .expect(200);
    expect(listB.body).toHaveLength(0);

    await request(app.getHttpServer())
      .get('/doctors/me/blocks/999999')
      .set('Authorization', `Bearer ${doctorB.token}`)
      .expect(404);
  });

  it('exposes a doctor weekly schedule to any authenticated user', async () => {
    const doctor = await registerUser(app, 'doctor', 'Dr Public Schedule');
    const patient = await registerUser(app, 'patient', 'Patient Schedule Viewer');
    emails.push(
      (await db.select({ email: users.email }).from(users).where(eq(users.id, doctor.user.id)))[0]!.email,
      (await db.select({ email: users.email }).from(users).where(eq(users.id, patient.user.id)))[0]!.email,
    );

    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({ entries: [{ dayOfWeek: 2, startTime: '09:00', endTime: '13:00' }] })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/schedule`)
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ dayOfWeek: 2, startTime: '09:00', endTime: '13:00' });

    await request(app.getHttpServer())
      .get(`/doctors/${doctor.user.id}/schedule`)
      .expect(401);

    await request(app.getHttpServer())
      .get('/doctors/999999/schedule')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(404);
  });

  it('lets a doctor list their own booked appointments with patient names', async () => {
    const doctor = await registerUser(app, 'doctor', 'Dr My Appointments');
    const patient = await registerUser(app, 'patient', 'Patient Booker');
    emails.push(
      (await db.select({ email: users.email }).from(users).where(eq(users.id, doctor.user.id)))[0]!.email,
      (await db.select({ email: users.email }).from(users).where(eq(users.id, patient.user.id)))[0]!.email,
    );

    const tomorrow = new Date(Date.now() + 86_400_000);
    const day = tomorrow.toISOString().slice(0, 10);
    const weekday = tomorrow.getUTCDay();
    const nextDay = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const nextWeekday = new Date(Date.now() + 2 * 86_400_000).getUTCDay();

    await request(app.getHttpServer())
      .put('/doctors/me/schedule')
      .set('Authorization', `Bearer ${doctor.token}`)
      .send({
        entries: [
          { dayOfWeek: weekday, startTime: '10:00', endTime: '12:00' },
          { dayOfWeek: nextWeekday, startTime: '10:00', endTime: '12:00' },
        ],
      })
      .expect(200);

    const booked = await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: `${day}T10:00:00.000Z` })
      .expect(201);

    await request(app.getHttpServer())
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ doctorId: doctor.user.id, startTime: `${nextDay}T10:00:00.000Z` })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/doctors/me/appointments')
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      id: booked.body.id,
      patientId: patient.user.id,
      patientName: 'Patient Booker',
      status: 'scheduled',
    });

    const filtered = await request(app.getHttpServer())
      .get(`/doctors/me/appointments?from=${day}&to=${day}`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(200);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].id).toBe(booked.body.id);

    const filteredAll = await request(app.getHttpServer())
      .get(`/doctors/me/appointments?from=${day}&to=${nextDay}`)
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(200);
    expect(filteredAll.body).toHaveLength(2);

    await request(app.getHttpServer())
      .get('/doctors/me/appointments?from=not-a-date')
      .set('Authorization', `Bearer ${doctor.token}`)
      .expect(400);

    await request(app.getHttpServer())
      .get('/doctors/me/appointments')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(403);

    await db.delete(appointments).where(eq(appointments.patientId, patient.user.id));
  });
});