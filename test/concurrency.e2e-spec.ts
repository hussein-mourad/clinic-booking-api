import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.factory';
import { DRIZZLE, DATABASE_POOL } from '../src/database/database.module';
import type { Database } from '../src/database/database.module';
import { appointments, users } from '../src/database/schema';

const N = 25;

/** Raw fetch against the single in-process server (avoids supertest's per-request listen). */
async function api(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    token?: string;
    user?: { id: number };
    id?: number;
  };
  return { status: res.status, body: data };
}

async function register(
  url: string,
  role: 'patient' | 'doctor',
  name: string,
): Promise<{ token: string; user: { id: number } }> {
  const email = `${role}+${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await api(url, 'POST', '/auth/register', { email, password: 'secret123', name, role });
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  return { token: res.body.token!, user: res.body.user! };
}

describe('Concurrency proof (e2e)', () => {
  let app: INestApplication;
  let db: Database;
  let url: string;
  const emails: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
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

  it(`${N} simultaneous bookings for one slot => exactly one 201, rest 409`, async () => {
    const doctor = await register(url, 'doctor', 'Concurrency Doc');
    emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, doctor.user.id)))[0]!.email);

    await api(url, 'PATCH', '/doctors/me', { slotDurationMin: 30 }, doctor.token);
    await api(url, 'PUT', '/doctors/me/schedule', {
      entries: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '10:00',
        endTime: '16:00',
      })),
    }, doctor.token);

    const startTime = `${new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)}T10:00:00.000Z`;

    const patients = await Promise.all(
      Array.from({ length: N }, () => register(url, 'patient', 'Concurrency Patient')),
    );
    for (const p of patients) {
      emails.push((await db.select({ email: users.email }).from(users).where(eq(users.id, p.user.id)))[0]!.email);
    }

    const statuses = await Promise.all(
      patients.map((p) =>
        api(url, 'POST', '/appointments', { doctorId: doctor.user.id, startTime }, p.token).then(
          (r) => r.status,
        ),
      ),
    );

    const created = statuses.filter((s) => s === 201).length;
    const rejected = statuses.filter((s) => s === 409).length;
    console.log(`  concurrency: ${created} x201, ${rejected} x409 (N=${N})`);

    expect(created).toBe(1);
    expect(rejected).toBe(N - 1);
  });
});