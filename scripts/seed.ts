/**
 * End-to-end demo seed for the clinic booking API.
 *
 * Creates (or logs in) a demo doctor with a Sunday-Thursday 10:00-16:00
 * schedule and a few patients, then writes the doctor's working hours and slot duration through
 * the public API (the same path a real client uses). Idempotent: re-running
 * reuses existing accounts.
 *
 * Usage: bun run seed   (point API_URL elsewhere if needed)
 */

const API = process.env.API_URL ?? 'http://localhost:3000';
export const SEED_DOCTOR_EMAIL =
  process.env.SEED_DOCTOR_EMAIL ?? 'doctor@clinic.com';
export const SEED_DOCTOR_PASSWORD =
  process.env.SEED_DOCTOR_PASSWORD ?? 'secret123';
export const SEED_PATIENT_COUNT = Number(process.env.SEED_PATIENT_COUNT ?? 3);

interface AuthResult {
  token: string;
  user: { id: number; email: string; name: string; role: string };
}

async function json<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok)
    throw new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`,
    );
  return data;
}

async function authOrRegister(
  role: 'doctor' | 'patient',
  email: string,
  password: string,
  name: string,
): Promise<AuthResult> {
  try {
    return await json<AuthResult>('POST', '/auth/register', {
      email,
      password,
      name,
      role,
    });
  } catch (err) {
    if (String(err).includes('409')) {
      return await json<AuthResult>('POST', '/auth/login', {
        email,
        password,
      });
    }
    throw err;
  }
}

function isoInDays(days: number, hours = 9): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hours, 0, 0, 0);
  return d.toISOString();
}

async function main() {
  const doctor = await authOrRegister(
    'doctor',
    SEED_DOCTOR_EMAIL,
    SEED_DOCTOR_PASSWORD,
    'Demo Doctor',
  );
  const patients: AuthResult[] = [];
  for (let i = 0; i < SEED_PATIENT_COUNT; i++) {
    patients.push(
      await authOrRegister(
        'patient',
        `patient-${i}@clinic.com`,
        'secret123',
        `Patient ${i}`,
      ),
    );
  }

  await json('PATCH', '/doctors/me', { slotDurationMin: 30 }, doctor.token);
  await json(
    'PUT',
    '/doctors/me/schedule',
    {
      entries: [0, 1, 2, 3, 4].map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '10:00',
        endTime: '16:00',
      })),
    },
    doctor.token,
  );

  const from = isoInDays(1).slice(0, 10);
  const to = isoInDays(2).slice(0, 10);
  const slots = await json<Array<{ start: string }>>(
    'GET',
    `/doctors/${doctor.user.id}/slots?from=${from}&to=${to}`,
    undefined,
    patients[0]!.token,
  );

  const schedule = await json<
    Array<{ dayOfWeek: number; startTime: string; endTime: string }>
  >('GET', '/doctors/me/schedule', undefined, doctor.token);

  console.log('Seed complete');
  console.log(`  doctor id   = ${doctor.user.id} (${doctor.user.email})`);
  console.log(
    `  schedule    = ${schedule.length} days, e.g. ${JSON.stringify(schedule[0])}`,
  );
  console.log(
    `  slots       = ${slots.length} for ${from}..${to} (first: ${slots[0]?.start ?? '-'})`,
  );
  console.log(`  doctorToken = ${doctor.token}`);
  console.log(`  patientToken= ${patients[0]!.token}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
