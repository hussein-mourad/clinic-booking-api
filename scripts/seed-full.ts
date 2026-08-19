/**
 * Full demo seed for the clinic booking API.
 *
 * Writes realistic data directly to PostgreSQL via Drizzle (no HTTP, unlike
 * the minimal scripts/seed.ts). Demonstrates every app feature: doctors with
 * diverse schedules + slot durations + blocks, patients, a month of
 * appointments across working days (feeding Analytics), a waitlist offer
 * lifecycle (waiting -> offered -> accepted / expired / waiting), and
 * notifications (reminders + waitlist events).
 *
 * Idempotent: re-running wipes any previously seeded @clinic.com rows
 * (in FK-safe order) and reseeds with fresh data.
 *
 * Usage: npm run seed:full
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, like, or } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import * as schema from '../src/database/schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

type Db = NodePgDatabase<typeof schema>;

const DEMO_DOMAIN = '@clinic.com';
const PASSWORD = 'secret123';
const BCRYPT_ROUNDS = 10;
const OFFER_TTL_MIN = 15;

interface DoctorDef {
  name: string;
  slotDurationMin: 15 | 30 | 60;
  schedule: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
}

/** PRD example weekly schedule: Sunday-Thursday, 10:00-16:00. */
const PRD_SCHEDULE = [0, 1, 2, 3, 4].map((dayOfWeek) => ({
  dayOfWeek,
  startTime: '10:00',
  endTime: '16:00',
}));

const DOCTORS: DoctorDef[] = [
  {
    name: 'Dr Alice Cardiologist',
    slotDurationMin: 15,
    schedule: PRD_SCHEDULE,
  },
  {
    name: 'Dr Bob Dermatologist',
    slotDurationMin: 30,
    schedule: PRD_SCHEDULE,
  },
  {
    name: 'Dr Carol Psychiatrist',
    slotDurationMin: 60,
    schedule: PRD_SCHEDULE,
  },
];

const PATIENT_NAMES = [
  'Olivia Patient',
  'Liam Patient',
  'Emma Patient',
  'Noah Patient',
  'Ava Patient',
  'Ethan Patient',
  'Sophia Patient',
  'Mason Patient',
];

const DATES = currentMonthDates();
const DEMO_MONTH = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h! * 60 + m!;
};

const toHHMM = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** Deterministic demo dates per doctor index: one full-day and one partial-range block. */
const FULL_DAY_FOR = DATES.map((_, i) => DATES[(i * 7) % DATES.length]);
const PARTIAL_FOR = DATES.map((_, i) => DATES[(i * 13 + 3) % DATES.length]);

function currentMonthDates(): string[] {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    out.push(
      `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    );
  }
  return out;
}

/** Blocks active on a given date for a doctor (by its index). */
function blocksOn(doctorIndex: number, dateStr: string) {
  const out: Array<
    { startTime: string; endTime: string } | { startTime: null; endTime: null }
  > = [];
  if (FULL_DAY_FOR[doctorIndex] === dateStr)
    out.push({ startTime: null, endTime: null });
  if (PARTIAL_FOR[doctorIndex] === dateStr)
    out.push({ startTime: '12:00', endTime: '14:00' });
  return out;
}

/** Slot starts (UTC) for a doctor on a given date, respecting that date's blocks. */
function slotsForDay(
  doctor: DoctorDef,
  dateStr: string,
  dayOfWeek: number,
): string[] {
  const dayBlocks = blocksOn(DOCTORS.indexOf(doctor), dateStr);
  const out: string[] = [];
  for (const entry of doctor.schedule) {
    if (entry.dayOfWeek !== dayOfWeek) continue;
    let t = toMin(entry.startTime);
    const end = toMin(entry.endTime);
    while (t < end) {
      const tEnd = t + doctor.slotDurationMin;
      if (tEnd <= end) {
        const blocked = dayBlocks.some(
          (b) =>
            !b.startTime ||
            (t < toMin(b.endTime!) && tEnd > toMin(b.startTime!)),
        );
        if (!blocked) out.push(`${dateStr}T${toHHMM(t)}:00.000Z`);
      }
      t = tEnd;
    }
  }
  return out;
}

async function run() {
  const pool = new Pool({ connectionString });
  const db: Db = drizzle(pool, { schema });
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);

  await db.transaction(async (tx) => {
    // 1. Idempotent wipe of previous demo data (FK-safe order).
    const demo = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(like(schema.users.email, `%${DEMO_DOMAIN}`));
    const ids = demo.map((d) => d.id);
    if (ids.length > 0) {
      await tx
        .delete(schema.notifications)
        .where(inArray(schema.notifications.userId, ids));
      await tx
        .delete(schema.appointments)
        .where(
          or(
            inArray(schema.appointments.doctorId, ids),
            inArray(schema.appointments.patientId, ids),
          ),
        );
      await tx
        .delete(schema.waitingList)
        .where(
          or(
            inArray(schema.waitingList.doctorId, ids),
            inArray(schema.waitingList.patientId, ids),
          ),
        );
      await tx.delete(schema.users).where(inArray(schema.users.id, ids));
    }

    // 2. Doctors + patients.
    const doctorRows = await tx
      .insert(schema.users)
      .values(
        DOCTORS.map((d, i) => ({
          email: `doctor-${i}${DEMO_DOMAIN}`,
          passwordHash,
          name: d.name,
          role: 'doctor' as const,
          slotDurationMin: d.slotDurationMin,
        })),
      )
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
      });

    const patientRows = await tx
      .insert(schema.users)
      .values(
        PATIENT_NAMES.map((name, i) => ({
          email: `patient-${i}${DEMO_DOMAIN}`,
          passwordHash,
          name,
          role: 'patient' as const,
        })),
      )
      .returning({ id: schema.users.id, email: schema.users.email });

    // 3. Schedules.
    for (let i = 0; i < doctorRows.length; i++) {
      await tx.insert(schema.schedules).values(
        DOCTORS[i]!.schedule.map((s) => ({
          doctorId: doctorRows[i]!.id,
          dayOfWeek: s.dayOfWeek,
          startTime: s.startTime,
          endTime: s.endTime,
        })),
      );
    }

    // 4. Blocks.
    for (let i = 0; i < doctorRows.length; i++) {
      const fullDay = FULL_DAY_FOR[i];
      const partial = PARTIAL_FOR[i];
      await tx.insert(schema.blockedSlots).values([
        {
          doctorId: doctorRows[i]!.id,
          blockDate: fullDay,
          startTime: null,
          endTime: null,
        },
        {
          doctorId: doctorRows[i]!.id,
          blockDate: partial,
          startTime: '12:00',
          endTime: '14:00',
        },
      ]);
    }

    // 5. A month of appointments (completed/cancelled past, scheduled future).
    const appointmentsToInsert: Array<typeof schema.appointments.$inferInsert> =
      [];
    let patientIdx = 0;
    for (let di = 0; di < doctorRows.length; di++) {
      const def = DOCTORS[di]!;
      for (const dateStr of DATES) {
        const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
        const starts = slotsForDay(def, dateStr, dow);
        starts.forEach((start, idx) => {
          if (idx % 5 === 4) return; // leave every 5th slot open to show availability
          const startMs = Date.parse(start);
          const isPast = startMs < now - 2 * 3600_000;
          const status: 'completed' | 'cancelled' | 'scheduled' = isPast
            ? idx % 7 === 3
              ? 'cancelled'
              : 'completed'
            : idx % 11 === 5
              ? 'cancelled'
              : 'scheduled';
          patientIdx++;
          appointmentsToInsert.push({
            doctorId: doctorRows[di]!.id,
            patientId: patientRows[patientIdx % patientRows.length]!.id,
            startTime: new Date(startMs),
            endTime: new Date(startMs + def.slotDurationMin * 60_000),
            status,
            createdAt: new Date(
              startMs - (1 + (idx % 3)) * 86_400_000 + (idx % 12) * 3600_000,
            ),
            ...(status === 'cancelled'
              ? { cancelledAt: new Date(Math.min(now, startMs) - 3600_000) }
              : {}),
          });
        });
      }
    }
    await tx.insert(schema.appointments).values(appointmentsToInsert);

    // 6. Waitlist lifecycle on a booked near-future slot.
    const target = await tx
      .select()
      .from(schema.appointments)
      .where(
        and(
          eq(schema.appointments.doctorId, doctorRows[0]!.id),
          eq(schema.appointments.status, 'scheduled'),
        ),
      )
      .limit(1);
    if (target[0]) {
      const slot = target[0];
      const queued = await tx
        .insert(schema.waitingList)
        .values(
          patientRows.slice(0, 3).map((p, i) => ({
            doctorId: slot.doctorId,
            patientId: p.id,
            slotStart: slot.startTime,
            position: i + 1,
            status: 'waiting' as const,
          })),
        )
        .returning({
          id: schema.waitingList.id,
          patientId: schema.waitingList.patientId,
        });

      // Booked patient cancels -> slot frees up.
      await tx
        .update(schema.appointments)
        .set({ status: 'cancelled', cancelledAt: new Date(nowIso) })
        .where(eq(schema.appointments.id, slot.id));

      // Offer to position 1; they accept -> rebooked to them.
      const [offer] = queued;
      const offerExpiresAt = new Date(now + OFFER_TTL_MIN * 60_000);
      await tx
        .update(schema.waitingList)
        .set({ status: 'offered', offeredAt: new Date(nowIso), offerExpiresAt })
        .where(eq(schema.waitingList.id, offer!.id));
      await tx.insert(schema.notifications).values({
        userId: offer!.patientId,
        type: 'waitlist_offer',
        payload: {
          doctorId: slot.doctorId,
          slotStart: slot.startTime.toISOString(),
          offerExpiresAt: offerExpiresAt.toISOString(),
        },
        sentAt: new Date(nowIso),
      });
      await tx.insert(schema.appointments).values({
        doctorId: slot.doctorId,
        patientId: offer!.patientId,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: 'scheduled',
        createdAt: new Date(nowIso),
      });
      await tx
        .update(schema.waitingList)
        .set({ status: 'accepted' })
        .where(eq(schema.waitingList.id, offer!.id));
      await tx.insert(schema.notifications).values({
        userId: offer!.patientId,
        type: 'waitlist_confirmation',
        payload: {
          doctorId: slot.doctorId,
          slotStart: slot.startTime.toISOString(),
        },
        sentAt: new Date(nowIso),
      });

      // Position 2's offer expired (sweep target); position 3 stays waiting.
      const [, second] = queued;
      await tx
        .update(schema.waitingList)
        .set({
          status: 'expired',
          offeredAt: new Date(now - 30 * 60_000),
          offerExpiresAt: new Date(now - 15 * 60_000),
        })
        .where(eq(schema.waitingList.id, second!.id));
    }

    // 7. Reminder notifications for a couple of upcoming appointments.
    const upcoming = await tx
      .select()
      .from(schema.appointments)
      .where(
        and(
          eq(schema.appointments.doctorId, doctorRows[1]!.id),
          eq(schema.appointments.status, 'scheduled'),
        ),
      )
      .orderBy(schema.appointments.startTime)
      .limit(2);
    for (const a of upcoming) {
      await tx.insert(schema.notifications).values({
        userId: a.patientId,
        type: 'reminder',
        payload: {
          doctorId: a.doctorId,
          appointmentId: a.id,
          startTime: a.startTime.toISOString(),
        },
        sentAt: new Date(nowIso),
      });
    }

    // 8. Report.
    console.log('Full seed complete');
    console.log(`  password     = ${PASSWORD}`);
    console.log(
      `  doctors      = ${doctorRows.map((d) => `${d.id}:${d.email}`).join(', ')}`,
    );
    console.log(
      `  patients     = ${patientRows.length} (${patientRows.map((p) => p.email).join(', ')})`,
    );
    console.log(
      `  analytics    = GET /doctors/me/analytics?month=${DEMO_MONTH}`,
    );
    console.log(`  appointments = ${appointmentsToInsert.length}`);
  });

  await pool.end();
}

run().catch((err) => {
  console.error('Full seed failed:', err);
  process.exit(1);
});
