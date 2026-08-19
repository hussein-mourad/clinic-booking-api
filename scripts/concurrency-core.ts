/**
 * Core concurrency-proof logic shared by scripts/concurrency-proof.ts and
 * scripts/lb-proof.ts. Registers one doctor + N patients, sets a 7-day
 * 10:00-16:00 schedule, then fires N simultaneous bookings for the exact same
 * slot and asserts exactly ONE 201 and N-1 x 409.
 */

interface AuthResult {
  token: string;
  user: { id: number; email: string; name: string; role: string };
}

async function json<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

export interface ConcurrencyStats {
  total: number;
  created: number;
  rejected: number;
  others: number;
}

export async function runConcurrencyProof(
  baseUrl: string,
  n: number,
): Promise<ConcurrencyStats> {
  const stamp = Date.now();
  const doctor = await json<AuthResult>(baseUrl, 'POST', '/auth/register', {
    email: `proof-doctor-${stamp}@example.com`,
    password: 'secret123',
    name: 'Proof Doctor',
    role: 'doctor',
  });
  await json(baseUrl, 'PATCH', '/doctors/me', { slotDurationMin: 30 }, doctor.token);
  await json(
    baseUrl,
    'PUT',
    '/doctors/me/schedule',
    {
      entries: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        startTime: '10:00',
        endTime: '16:00',
      })),
    },
    doctor.token,
  );

  const startDay = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const startTime = `${startDay}T10:00:00.000Z`;

  const patients: string[] = [];
  for (let i = 0; i < n; i++) {
    const auth = await json<AuthResult>(baseUrl, 'POST', '/auth/register', {
      email: `proof-patient-${i}-${stamp}@example.com`,
      password: 'secret123',
      name: `Proof Patient ${i}`,
      role: 'patient',
    });
    patients.push(auth.token);
  }

  const statuses = await Promise.all(
    patients.map((token) =>
      fetch(`${baseUrl}/appointments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ doctorId: doctor.user.id, startTime }),
      }).then((res) => res.status),
    ),
  );

  const created = statuses.filter((s) => s === 201).length;
  const rejected = statuses.filter((s) => s === 409).length;
  return { total: n, created, rejected, others: n - created - rejected };
}