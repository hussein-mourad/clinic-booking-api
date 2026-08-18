import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { DRIZZLE, DATABASE_POOL } from '../src/database/database.module';
import type { Database } from '../src/database/database.module';
import { users } from '../src/database/schema';

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
      await db.delete(users).where(eq(users.email, email));
    }
    await (app.get(DATABASE_POOL) as Pool).end();
    await app.close();
  });

  it('rejects unauthenticated access with 401', async () => {
    await request(app.getHttpServer()).get('/doctors/1/schedule').expect(401);
  });

  it('doctor sets and reads a weekly schedule', async () => {
    const { token, user } = await registerUser(app, 'doctor', 'Dr Schedule');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!.email);

    const put = await request(app.getHttpServer())
      .put(`/doctors/${user.id}/schedule`)
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
      .get(`/doctors/${user.id}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(get.body).toHaveLength(2);
  });

  it('rejects duplicate days and inverted times', async () => {
    const { token, user } = await registerUser(app, 'doctor', 'Dr Bad Schedule');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!.email);

    await request(app.getHttpServer())
      .put(`/doctors/${user.id}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        entries: [
          { dayOfWeek: 1, startTime: '10:00', endTime: '16:00' },
          { dayOfWeek: 1, startTime: '08:00', endTime: '09:00' },
        ],
      })
      .expect(400);

    await request(app.getHttpServer())
      .put(`/doctors/${user.id}/schedule`)
      .set('Authorization', `Bearer ${token}`)
      .send({ entries: [{ dayOfWeek: 2, startTime: '16:00', endTime: '10:00' }] })
      .expect(400);
  });

  it('sets slot duration and rejects invalid values', async () => {
    const { token, user } = await registerUser(app, 'doctor', 'Dr Duration');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!.email);

    await request(app.getHttpServer())
      .patch(`/doctors/${user.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slotDurationMin: 30 })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/doctors/${user.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slotDurationMin: 45 })
      .expect(400);
  });

  it('adds and removes blocked slots', async () => {
    const { token, user } = await registerUser(app, 'doctor', 'Dr Blocks');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, user.id)))[0]!.email);

    const fullDay = await request(app.getHttpServer())
      .post(`/doctors/${user.id}/blocks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ blockDate: '2026-08-25' })
      .expect(201);
    expect(fullDay.body).toMatchObject({ doctorId: user.id, blockDate: '2026-08-25', startTime: null, endTime: null });

    const range = await request(app.getHttpServer())
      .post(`/doctors/${user.id}/blocks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ blockDate: '2026-08-26', startTime: '12:00', endTime: '14:00' })
      .expect(201);
    expect(range.body.startTime).toBe('12:00');

    await request(app.getHttpServer())
      .post(`/doctors/${user.id}/blocks`)
      .set('Authorization', `Bearer ${token}`)
      .send({ blockDate: '2026-08-27', startTime: '12:00' })
      .expect(400);

    await request(app.getHttpServer())
      .delete(`/doctors/${user.id}/blocks/${range.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/doctors/${user.id}/blocks/${range.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('forbids patients and other doctors from managing a schedule', async () => {
    const patient = await registerUser(app, 'patient', 'Patient');
    const doctorA = await registerUser(app, 'doctor', 'Dr A');
    const doctorB = await registerUser(app, 'doctor', 'Dr B');
    emails.push(
      (await db.select({ email: users.email }).from(users).where(eq(users.id, patient.user.id)))[0]!.email,
      (await db.select({ email: users.email }).from(users).where(eq(users.id, doctorA.user.id)))[0]!.email,
      (await db.select({ email: users.email }).from(users).where(eq(users.id, doctorB.user.id)))[0]!.email,
    );

    await request(app.getHttpServer())
      .put(`/doctors/${doctorA.user.id}/schedule`)
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ entries: [{ dayOfWeek: 0, startTime: '10:00', endTime: '16:00' }] })
      .expect(403);

    await request(app.getHttpServer())
      .put(`/doctors/${doctorA.user.id}/schedule`)
      .set('Authorization', `Bearer ${doctorB.token}`)
      .send({ entries: [{ dayOfWeek: 0, startTime: '10:00', endTime: '16:00' }] })
      .expect(403);
  });
});