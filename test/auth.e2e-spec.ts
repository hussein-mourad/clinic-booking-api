import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { DRIZZLE, DATABASE_POOL } from '../src/db/database.module';
import type { Database } from '../src/db/database.module';
import { users } from '../src/db';

describe('Auth (e2e)', () => {
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

  it('registers a patient and returns a token', async () => {
    const email = `patient+${Date.now()}@example.com`;
    emails.push(email);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'secret123', name: 'Test Patient' })
      .expect(201);

    expect(res.body.token).toBeDefined();
    expect(res.body.user).toMatchObject({ email, name: 'Test Patient', role: 'patient' });
  });

  it('registers a doctor when role is set', async () => {
    const email = `doctor+${Date.now()}@example.com`;
    emails.push(email);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'secret123', name: 'Dr One', role: 'doctor' })
      .expect(201);

    expect(res.body.user.role).toBe('doctor');
  });

  it('rejects duplicate email with 409', async () => {
    const email = `dup+${Date.now()}@example.com`;
    emails.push(email);
    const creds = { email, password: 'secret123', name: 'Dup' };

    await request(app.getHttpServer()).post('/auth/register').send(creds).expect(201);
    await request(app.getHttpServer()).post('/auth/register').send(creds).expect(409);
  });

  it('logs in with valid credentials and returns a token', async () => {
    const email = `login+${Date.now()}@example.com`;
    emails.push(email);
    const creds = { email, password: 'secret123', name: 'Login' };

    await request(app.getHttpServer()).post('/auth/register').send(creds).expect(201);

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'secret123' })
      .expect(200);

    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('patient');
  });

  it('rejects wrong password with 401', async () => {
    const email = `badpw+${Date.now()}@example.com`;
    emails.push(email);
    const creds = { email, password: 'secret123', name: 'BadPW' };

    await request(app.getHttpServer()).post('/auth/register').send(creds).expect(201);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-pass' })
      .expect(401);
  });

  it('rejects malformed payloads with 400', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'secret123', name: 'X' })
      .expect(400);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nope' })
      .expect(400);
  });
});